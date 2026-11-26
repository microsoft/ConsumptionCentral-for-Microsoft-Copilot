# Manual Fabric setup: Studio credit reports preview

This is an opt-in alternative to the installer's preview flow. The matching generated flow has
been tenant-validated through generation, download, paired OneLake publication and Fabric
ingestion, including a valid empty billing report. This hand-built path has not been independently
executed. Verify its connector responses and downloaded pair before relying on it. The API is a
public preview and is unavailable in sovereign clouds. The reports can include non-Studio
resources, and the billing report is not product-specific. They contain no per-user detail.
Keep the existing licensing flow and CSV exports for fallback and historical or user detail.

## Prerequisites

- A Power Platform for Admins V2 **OAuth Connection** signed in as a Global, Power Platform or
  Dynamics 365 administrator. The reports API does not support application-only authentication.
- A Power Automate environment, license and DLP policy that allow this connector and **HTTP with
  Microsoft Entra ID (preauthorized)**. The latter is a Premium connector. Its signed-in identity
  needs write access to the target Lakehouse.
- An imported `Ingest_Studio` notebook attached to the target Lakehouse. Create its
  `Files/landing/studio` folder before running the flow.

The flow below mirrors the installer's current preview definition. Use the exact action names:
expressions reference them. In expressions below, enter the expression without the surrounding
backticks. Do not put credentials in the flow definition, repository or run-history notes.

## Build the flow

1. Create a scheduled cloud flow, daily, at least an hour before the Fabric ingestion pipeline.
   Set trigger concurrency to one. Report generation can exceed an hour, so a pipeline may use
   the previous completed pair.
2. Add these **Initialize variable** actions in order. All variables are strings. Enter date and
   run ID values as expressions:

   | Name | Value |
   |---|---|
   | `Anchor` | `formatDateTime(utcNow(),'yyyy-MM-dd')` |
   | `FromDate` | `formatDateTime(addDays(variables('Anchor'),-14),'yyyy-MM-dd')` |
   | `ToDate` | `formatDateTime(addDays(variables('Anchor'),-1),'yyyy-MM-dd')` |
   | `RunId` | `concat(formatDateTime(utcNow(),'yyyyMMddHHmmssfffffff'),'_',guid())` |
   | `FeatureStatus` | `Running` |
   | `BillingStatus` | `Running` |

3. Configure each of the two reports **sequentially**, first Feature, then Billing. Follow
   [Microsoft's submit, poll and download instructions](https://learn.microsoft.com/power-platform/admin/programmability-tutorial-download-copilot-credit-usage-reports)
   for each, using the settings below. Use `Daily` granularity and the variables `FromDate` and
   `ToDate`; omit format so the connector uses its current default. Do not use the tutorial's
   JSON-only row-processing steps.

   | Report | Submit action name | Poll action name | Download action name | Status variable |
   |---|---|---|---|---|
   | `FeatureDetailsPerResource` | `Submit_Feature` | `Poll_Feature` | `Download_Feature` | `FeatureStatus` |
   | `BillingDetailsPerEnvironment` | `Submit_Billing` | `Poll_Billing` | `Download_Billing` | `BillingStatus` |

   For each **Generate Licensing Report**, use API version `2024-10-01` and disable automatic
   retries. The connector can wait for generation and return HTTP 200: require `status` =
   `Succeeded` and a nonempty `fileName`, then download that file without polling. Otherwise,
   require HTTP 202, check that the `Location` begins with
   `https://api.powerplatform.com/`, its final path segment is nonempty, and `Retry-After` is a
   positive integer. Stop the flow as failed if any check fails. For the Feature report, for
   example, extract the operation ID with:

   ```text
   last(split(uriPath(coalesce(outputs('Submit_Feature')?['headers']?['Location'],outputs('Submit_Feature')?['headers']?['location'],'')),'/'))
   ```

   For HTTP 202 only, wait the returned `Retry-After` seconds before polling; never substitute zero. In a **Do until**
   loop, call **Get Licensing Report Operation Status** using the report name, extracted operation
   ID and the same API version. Set the status variable from the response's `status`. While it is
   `Running`, wait the poll response's positive integer `Retry-After` before the next poll; fail if
   it is absent or invalid. Configure a maximum of 120 iterations and a two-hour timeout, with
   failure on limit. Disable retries on the connector actions, and fail the run on a poll failure,
   missing status, or a terminal status other than `Succeeded`. After success, require a nonempty
   `fileName` and call **Download Licensing Report File** with that name, report name and API
   version. Do not submit a second operation when polling fails. If a submission returns 429,
   inspect it and wait at least the supplied `Retry-After` before retrying manually.

4. Only after **both** downloads succeed, add a **Compose** named `Package_reports` with:

   ```text
   setProperty(setProperty(setProperty(setProperty(json('{}'),'startDate',variables('FromDate')),'endDate',variables('ToDate')),'feature',body('Download_Feature')),'billing',body('Download_Billing'))
   ```

   The bodies may be CSV text or a connector binary wrapper; preserve them rather than converting
   or parsing them in the flow. Enable secure inputs and outputs on the downloads. Enable only
   secure inputs on `Package_reports`: Compose does not support an explicit secure-output
   setting, and securing its inputs also hides its output. Never save a partial pair.
5. Connect **HTTP with Microsoft Entra ID (preauthorized)** to OneLake, using
   `https://onelake.dfs.fabric.microsoft.com` as the base resource URL and
   `https://storage.azure.com` as the Microsoft Entra resource URI. Sign in with an identity
   that can write to the Lakehouse. Use the workspace and Lakehouse identifiers from Fabric; do
   not mix a name and an identifier in the OneLake path.
6. Create a filename once with a Compose action named `Report_file`:

   ```text
   concat('StudioReportsPreview_',variables('RunId'),'.json')
   ```

   Use two sequential HTTP-with-Entra actions, with `x-ms-version: 2023-11-03` on both. Replace
   the placeholders below locally with the workspace and Lakehouse identifiers and insert the
   `Report_file` output as dynamic content:

   | Method | URL suffix after `https://onelake.dfs.fabric.microsoft.com` | Body |
   |---|---|---|
   | `PUT` | `/<workspace>/<lakehouse>/Files/landing/studio/<Report_file>?resource=file` | Empty |
   | `PATCH` | `/<workspace>/<lakehouse>/Files/landing/studio/<Report_file>?action=append&position=0&flush=true` | `string(outputs('Package_reports'))` |

   Set `Content-Type: application/json` on the PATCH. Enable secure inputs on both actions.
   Avoid running ingestion concurrently with the two storage actions. If file creation succeeds
   but the write fails, remove that run's incomplete file before retrying. The notebook skips
   empty files but rejects nonempty malformed packages.

## Enable ingestion and check

Set `READ_REPORT_API_FILES = True` in `Ingest_Studio`, leaving `READ_API_FILES` enabled if using
the existing licensing flow. Run the flow once, wait for both reports and check the package lands
in the notebook's `LANDING` folder. Run the notebook and inspect its output and tables before
refreshing the semantic model. The notebook rejects malformed or oversized pairs, ignores pairs
more than three days old, and preserves export precedence. Check the
[installer's preview notes](../../installer/README.md#copilot-studio-usage-reports-preview) for
size limits, retention, fallback and interpretation caveats.

To opt out, disable the preview flow and set `READ_REPORT_API_FILES = False`. Do not delete the
existing flow or exports. Do not enable a disabled pipeline schedule merely to test this setup.
