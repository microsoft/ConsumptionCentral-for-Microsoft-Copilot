# Manual Studio credit reports to SharePoint (preview)

This flow saves complete pairs of Power Platform reports to SharePoint. The Viva Direct
template reads them through `SourceFiles`, with separate **Power Platform Credit Resources**
and **Power Platform Credit Billing** tables. The app accepts CSVs, not paired JSON.
Report generation and download have been tenant-validated with the Fabric writer, and Desktop
has loaded the downloaded pair. SharePoint delivery and the live Viva Direct connector remain
unverified. These separate tables are not displayed by the existing Studio page visuals.
Keep existing exports and the licensing flow as fallbacks. The public preview is unavailable
in sovereign clouds and requires Power Automate Premium.

1. Sign in to Power Platform for Admins V2 with a Global, Power Platform or Dynamics 365
   administrator account. Use an environment whose license and DLP rules permit the connector
   and SharePoint. Sign in to SharePoint with an identity allowed to create files in the chosen
   folder. Limit folder access because the reports can contain sensitive resource details.
2. Create a scheduled cloud flow with trigger concurrency one. Follow steps **2–4** of the
   [manual reports flow](../2.%20Fabric/flows/STUDIO-REPORTS-MANUAL.md#build-the-flow) to
   initialize variables, generate and poll both reports, download them and compose the complete
   `Package_reports`. Keep retries, action-specific secure-data settings, and failure checks as described
   there. The OneLake writer in steps 5–6 does not apply.
3. Add a SharePoint **Create file** action after `Package_reports` succeeds. Select the site and
   destination folder, enter the following filename as an expression, and set file content to
   `string(outputs('Package_reports'))`:

   ```text
   concat('StudioReportsPreview_',variables('RunId'),'.json')
   ```

   Enable secure inputs on the action. Its destination folder must already exist; configure
   retention and access according to your organization's data policy. Never publish one report
   without the other.
4. Set `SharePointSiteUrl` and `DataFolder` on the template using the adjacent
   `SourceFiles.SharePoint.m` query (the automated No Fabric installer does this).
   Run the flow once, verify both report downloads and the SharePoint write, and refresh the
   model. The newest nonempty pair is used only when its end date is within three days of today.
   Malformed pairs fail refresh; stale/absent pairs leave these optional tables empty.
   Existing CSV views remain available. Leave existing export and licensing-flow schedules unchanged.

Resources are not necessarily agents; resource type and harness type are retained when supplied.
Non-billed credits do not establish entitlement or prepaid coverage. Environment billing has no
product dimension and is not labeled Studio-only. Resource and billing views overlap and must
not be added together or to existing product/person totals.

