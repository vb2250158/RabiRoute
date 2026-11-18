# Social media workspace

English | [简体中文](README.md)

This directory holds RabiRoute content drafts and assets for Bilibili, Douyin, Zhihu, WeChat Official Accounts, Xiaohongshu, linux.do, V2EX, Juejin, Sspai, X, Hacker News and Reddit.

Only the two README files belong in Git. Captures, drafts, exports and publication records stay local.

## Directory layout

| Directory | Contents | Track in Git |
| --- | --- | --- |
| `01-raw/screenshots/` | Original screenshots containing real interfaces | No |
| `01-raw/recordings/` | Screen recordings and source footage | No |
| `02-final/video/` | Edited videos and vertical clips | No |
| `02-final/image/` | Finished images, cards and GIFs | No |
| `02-final/cover/` | Platform cover images | No |
| `03-copy/<platform>/` | Text, titles and tag drafts | Only individually reviewed public text |
| `04-publish/` | Publication and metric records | No |
| `05-temp/` | Rebuildable intermediate files | No |

## Naming

Use `<date>-<platform>-<topic>-<version>.<ext>`.

- `2026-11-21-douyin-commute-test-v1.mp4`
- `2026-11-26-bilibili-install-full-v2.mp4`
- `2026-12-02-v2ex-first-post.md`

Start at `v1` and increment it for each revision.

## Publication records

Keep `04-publish/publish-log.csv` aligned with the social media schedule. Record the date, platform, title, link, status, views or reads, likes or saves, new group members and notes.

Use `draft`, `ready`, `published` and `reviewed` for status.

## Git exclusions

```gitignore
/social-media/*
!/social-media/README.md
!/social-media/README_en.md
```

Original captures can contain account identifiers, private messages, local paths and network addresses. Large media and frequently changing drafts also stay outside source history. Review each public text artifact individually before explicitly adding it.

## Working conventions

- Check the project's redaction checklist before moving material into `02-final/`.
- Clear unused `05-temp/` intermediates weekly.
- Update metrics after 72 hours and one week.
- Keep source code in its existing project directories.
