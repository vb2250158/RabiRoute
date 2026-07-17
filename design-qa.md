<!-- docs-language-switch -->
<div align="center">
English | <a href="./design-qa_zh.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Project Docs layout design QA

> Status: historical UI QA record. The original reference image and implementation screenshots were not committed, so this file preserves conclusions rather than reproducible visual evidence.

## Test state

- Route: `/docs`.
- Page: project overview.
- Viewport: 1568 × 1100.
- Search: empty.
- Source visual truth: a user-provided reference image that is not in the repository.

## Layout conclusion

The reference used a top documentation bar, a left section tree, continuous article content, and a right in-page table of contents. The implementation retained the RabiRoute application shell and light brand theme while reproducing that three-column reading model.

The recorded desktop columns were `244px 764px 190px`. The right table of contents was visible after the document-page grid selector was given sufficient scope.

The implementation did not copy the reference product's dark theme, branding, navigation copy, or content. Those differences were intentional. No additional image assets were required.

## Findings

- P3: RabiRoute already has a global application sidebar, leaving less width for documentation than the reference. The three-column document layout still remained usable.
- P3: Feature details retained lightweight fact cards for source of truth, consumers, activation timing, and side effects. Sections otherwise used continuous article layout.

No actionable P0, P1, or P2 findings remained in the recorded final pass.

## Fidelity checks

- Typography used the existing Chinese font stack and preserved clear heading, lead, body, and local-navigation hierarchy.
- Spacing, separators, sticky navigation, and responsive single-column fallback matched the intended reading behavior.
- Colors stayed within the RabiRoute light cyan/green design tokens.
- Page copy continued to use RabiRoute data rather than reference-product text.

## Interaction and runtime checks

- Selecting the boundary-rules section showed one matching target heading.
- Searching for `Outbox` filtered the navigation to related pages.
- The right-side anchors were generated from the active page.
- Collapsible desktop groups hid child items independently.
- Selecting the Configuration group navigated to its Route Configuration landing page.
- Mobile retained reachable page pills and hid only the redundant group chevron.
- The browser console had no application errors.
- `npm run webgui:build` passed at the time of the QA run.

## History and follow-up

The first pass lost the right table of contents because an older `.docs-layout` rule overrode the grid. Increasing selector scope restored the expected columns.

A future focused-reading mode could collapse the global application sidebar on `/docs`, giving the document layout more horizontal space.
