# Reading knowledge results on glasses

English | [简体中文](knowledge-result-view.md)

A query speaks only a brief summary by default. Records are not automatically read at length, executed as instructions, or submitted as model continuation prompts. Say `读出工具结果` to read the result, then `下一条工具结果` for the next segment. While the model is answering, reading is deferred. Text uses the existing reply area, with the page number in the status line.

Only successful, non-uncertain structured receipts are readable. Fixed record fields (identifier, title, focus, content, detail and related text) are extracted, limited to 20 records and 12000 Unicode code points. Each page has at most 50 visual budget units (common Chinese characters count as 2, ASCII as 1). HTML-like or instruction-like text in ordinary notes remains literal data; it is not executed. Missing displayable fields produce an explicit no-displayable-content message, not a claim that the query returned no records.

Results are bound to the device ownership scope and explicitly selected role; switching invalidates access. Original model text is retained, and HUD rendering uses separate bounded display fields. Use the PC interface for complete records beyond these limits. This is locally simulated validation, not real-device or automatic model continuation acceptance.
