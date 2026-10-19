# Synthetic Cowork tasks

These two files are wholly synthetic and are not anonymized customer rows. Keep this directory beneath the main sample folder so its `PeopleMetaData.csv` is not confused with the legacy companion in the parent directory.

The sample includes fractional credits, a historical organization change, both initiation types, Unknown, Unclassified and a measured-zero task row.

| All-history result | Expected |
|---|---:|
| Reported tasks | 10 |
| Task credits | 38 |
| Credits per task | 3.8 |
| Tasks covered by initial assumptions | 7 (70%) |
| Conservative expert-equivalent minutes | 111 |
| Typical expert-equivalent minutes | 235 |
| Optimistic expert-equivalent minutes | 358 |

Divide minutes by 60 for estimated hours. At an explicitly selected USD 50 per expert hour, the Typical monetary equivalent is USD 195.8333 before display rounding. At the neutral USD 0.01 PAYG credit rate, estimated task consumption cost is USD 0.38. Neither is an observed financial benefit or billed amount.

Point Local CSV `DataFolder` at the parent sample directory to exercise coexistence with the existing products, or at this directory for a task-only import. For an old-export case, use a separate fixture directory containing only the legacy files; do not delete or move user data for testing.
