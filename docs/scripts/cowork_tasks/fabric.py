"""Task ingestion helpers embedded in the Fabric Viva notebook (no client-side writes)."""
import datetime
import decimal
import math
import re

TASK_COLUMNS = {
    "person_id": ("PersonId",),
    "user_principal_name": ("UserPrincipalName", "UPN"),
    "metric_date": ("MetricDate",),
    "task_category": ("TaskCategory",),
    "task_type": ("TaskType",),
    "credits_used": ("CreditsUsed", "Total credits used"),
    "task_count": ("TaskCount", "Total Cowork tasks"),
    "people_historical_id": ("PeopleHistoricalId",),
    "organization": ("Organization", "Organisation"),
    "function_type": ("FunctionType",),
    "is_copilot_licensed": ("IsCopilotLicensed",),
}
TASK_SCHEMA = (
    "person_id string, user_principal_name string, metric_date date, "
    "task_category string, task_type string, credits_used double, task_count long, "
    "people_historical_id string, organization string, function_type string, is_copilot_licensed boolean"
)
TASK_KEYS = ["person_id", "metric_date", "category_key", "type_key"]


def task_key(name):
    return re.sub("[^a-z0-9]", "", name.lower())


def task_error(field, problem):
    raise ValueError(f"Cowork tasks: {field}: {problem}")


def task_bind(record, columns):
    result = {}
    for canonical, aliases in columns.items():
        # Match the M contract's exact PascalCase canonical spelling first.
        preferred = aliases[0]
        matches = [name for name in record if task_key(name) in {
            task_key(alias) for alias in (canonical,) + aliases}]
        if preferred in matches:
            name = preferred
        elif len(matches) > 1:
            task_error(canonical, "ambiguous aliases; keep one source column")
        else:
            name = matches[0] if matches else None
        value = record.get(name) if name else None
        result[canonical] = str(value).strip() if value is not None else None
        if result[canonical] == "":
            result[canonical] = None
    return result


def task_number(value, field, optional=False, integral=False):
    if value is None:
        if optional:
            return None
        task_error(field, "a required numeric value is missing")
    try:
        parsed = decimal.Decimal(value)
    except decimal.InvalidOperation:
        task_error(field, "expected a finite nonnegative number")
    if not parsed.is_finite() or parsed < 0:
        task_error(field, "expected a finite nonnegative number")
    if integral:
        if parsed != parsed.to_integral_value() or parsed > 9007199254740991:
            task_error(field, "expected a nonnegative whole count within the supported integer range")
        return int(parsed)
    value = float(parsed)
    if not math.isfinite(value):
        task_error(field, "expected a finite nonnegative number")
    return value


def task_licence(value):
    if value is None:
        return None
    if value.lower() in ("true", "yes", "1"):
        return True
    if value.lower() in ("false", "no", "0"):
        return False
    task_error("is_copilot_licensed", "expected true/false, yes/no or 1/0")


def normalise_task(record):
    row = task_bind(record, TASK_COLUMNS)
    for key in ("person_id", "user_principal_name", "people_historical_id"):
        row[key] = row[key].lower() if row[key] else None
    row["person_id"] = row["person_id"] or row["user_principal_name"]
    if not row["person_id"]:
        task_error("person_id", "a populated PersonId or UserPrincipalName is required")
    date = row["metric_date"]
    if not date or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        task_error("metric_date", "expected an ISO week-start date (yyyy-MM-dd)")
    try:
        row["metric_date"] = datetime.date.fromisoformat(date)
    except ValueError:
        task_error("metric_date", "expected a valid ISO week-start date")
    row["task_count"] = task_number(row["task_count"], "task_count", integral=True)
    row["credits_used"] = task_number(row["credits_used"], "credits_used", optional=True)
    row["is_copilot_licensed"] = task_licence(row["is_copilot_licensed"])
    for key in ("task_category", "task_type"):
        row[key] = row[key] or "Not supplied"
    return row


def normalise_task_metadata(record):
    names = ("people_historical_id", "organization", "function_type", "is_copilot_licensed")
    row = task_bind(record, {name: TASK_COLUMNS[name] for name in names})
    row["people_historical_id"] = row["people_historical_id"].lower() if row["people_historical_id"] else None
    row["is_copilot_licensed"] = task_licence(row["is_copilot_licensed"])
    return row


def viva_landing_files(fs, path):
    """Inspect only the configured landing tree, excluding archived/hidden data."""
    files = []
    for entry in fs.ls(path):
        if entry.name.startswith(("_", ".")):
            continue
        if entry.isDir:
            files.extend(viva_landing_files(fs, entry.path))
        elif entry.name.lower().endswith(".csv"):
            files.append(entry.path)
    return sorted(files)


def task_project(frame, function, schema, functions):
    project = functions.udf(lambda row: function(row.asDict()), schema)
    fields = [functions.col("`" + name.replace("`", "``") + "`").alias(name) for name in frame.columns]
    return frame.select(project(functions.struct(*fields)).alias("_task")).select("_task.*")


def task_read_project(spark, path, function, schema, functions):
    # CSV cannot infer even a header schema from a zero-byte file.
    if spark.read.text(path).limit(1).count() == 0:
        return spark.createDataFrame([], schema)
    raw = spark.read.option("header", True).option("inferSchema", False).csv(path)
    return task_project(raw, function, schema, functions)


def ingest_tasks(spark, paths, landing_files, table_name, functions, delta):
    """Separate optional Delta fact; never union task activity into legacy billing."""
    if not paths:
        print("Task categories not supplied; existing task history is unchanged.")
        return []
    combined = None
    consumed = []
    for path in paths:
        tasks = task_read_project(spark, path, normalise_task, TASK_SCHEMA, functions)
        companion = next((p for p in landing_files if p.rsplit("/", 1)[0] == path.rsplit("/", 1)[0]
                          and p.rsplit("/", 1)[-1].lower() == "peoplemetadata.csv"), None)
        consumed.append(path)
        if companion:
            metadata = task_read_project(spark, companion, normalise_task_metadata,
                "people_historical_id string, organization string, function_type string, is_copilot_licensed boolean",
                functions).filter(functions.col("people_historical_id").isNotNull()).dropDuplicates()
            if metadata.groupBy("people_historical_id").count().filter(functions.col("count") > 1).limit(1).count():
                task_error("people_historical_id", "conflicting metadata rows; reconcile the companion export")
            tasks = tasks.alias("t").join(metadata.alias("m"), "people_historical_id", "left").select(
                *[functions.coalesce(functions.col("t." + name), functions.col("m." + name)).alias(name)
                  if name in ("organization", "function_type", "is_copilot_licensed")
                  else functions.col(name if name == "people_historical_id" else "t." + name).alias(name)
                  for name in TASK_COLUMNS])
            consumed.append(companion)
        combined = tasks if combined is None else combined.unionByName(tasks)
    combined = (combined.withColumn("category_key", functions.lower(functions.col("task_category")))
                .withColumn("type_key", functions.lower(functions.col("task_type"))).dropDuplicates())
    if combined.groupBy(*TASK_KEYS).count().filter(functions.col("count") > 1).limit(1).count():
        task_error("task_count", "conflicting rows share person, week, category and type")
    combined = combined.withColumn("_loaded_at", functions.current_timestamp())
    if spark.catalog.tableExists(table_name):
        existing = spark.table(table_name)
        if existing.groupBy(*TASK_KEYS).count().filter(functions.col("count") > 1).limit(1).count():
            task_error("task_count", "existing task history has duplicate keys; reconcile before merging")
        condition = " AND ".join(f"t.{key} = s.{key}" for key in TASK_KEYS)
        (delta.forName(spark, table_name).alias("t").merge(combined.alias("s"), condition)
            .whenMatchedUpdateAll().whenNotMatchedInsertAll().execute())
    else:
        combined.write.format("delta").saveAsTable(table_name)
    print(f"{table_name}: processed {combined.count():,} task rows; historical keys are upserted.")
    return consumed
