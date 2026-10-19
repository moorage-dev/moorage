---
"@moorage/plugin-analytics": patch
---

Fixes "Those places, plus India" under "Who sees the cookie banner": with it chosen, no visitor was asked, so the tools loaded without consent everywhere, Europe and India included, while the Status tab said visitors there were asked. Visitors in the EU, the EEA, the UK, Switzerland and India are now asked first, and nothing loads before they answer, as with the Europe choice. Sites that use the Europe choice or ask everyone were not affected.
