let
    Raw = GetTable("cowork_tasks_weekly"),
    Empty = #table(type table [
        PersonId=text, UserPrincipalName=text, MetricDate=date,
        TaskCategory=text, TaskType=text, CreditsUsed=number, TaskCount=Int64.Type,
        PeopleHistoricalId=text, Organization=text, FunctionType=text, IsCopilotLicensed=logical
    ], {})
in
    [Data=if Raw = null then Empty else Raw, People=null, Supplied=Raw <> null]
