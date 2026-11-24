# Fonts

Self-hosted so the page makes no request to Google Fonts. Latin subset only
(`unicode-range` in `style.css` matches the one Google serves). All four files
are under the SIL Open Font License 1.1; see `OFL.txt`.

| File | Family, weight | Size | Source |
|---|---|---|---|
| `bricolage-grotesque-700.woff2` | Bricolage Grotesque 700 (opsz 12..96) | 39,736 B | https://fonts.gstatic.com/s/bricolagegrotesque/v9/3y9H6as8bTXq_nANBjzKo3IeZx8z6up5BeSl9D4dj_x9PpZBMnuECoAsyJBOm_OJvSCwA1XphjhQYg.woff2 |
| `inter-400.woff2` | Inter 400 | 23,804 B | https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2 |
| `inter-500.woff2` | Inter 500 | 24,356 B | https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuI6fAZ9hiJ-Ek-_EeA.woff2 |
| `inter-600.woff2` | Inter 600 | 24,420 B | https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuGKYAZ9hiJ-Ek-_EeA.woff2 |

Fetched 2026-11-23 from the Google Fonts CSS2 API with a desktop Chrome
User-Agent (the API serves woff2 only to modern browsers), taking the
`/* latin */` block of:

- `https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700`
- `https://fonts.googleapis.com/css2?family=Inter:wght@400` (and `@500`, `@600`;
  asked one weight at a time, the API serves a static instance per weight
  instead of one variable file)

Licence text: https://github.com/google/fonts/blob/main/ofl/bricolagegrotesque/OFL.txt
and https://github.com/rsms/inter/blob/master/LICENSE.txt (same OFL 1.1 body;
both copyright lines are in `OFL.txt`).
