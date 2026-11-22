---
description: Start Business Finder, or find businesses on Google Maps for a business type in a city.
argument-hint: "[business type] in [city]"
---

Follow every rule in `skills/business-finder/SKILL.md`. If `$ARGUMENTS` is empty, start Business Finder. Otherwise it is a search request: the business type is the text before the last ` in `, the place is the text after it. If there is no ` in `, ask the user for the city. Never open the result file and never ask the HTTP API for a job's rows.
