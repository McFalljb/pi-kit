- Default to running the existing tests for what you changed. Do not write tests for
  reversible, low-impact changes or tests that mirror the implementation. Add a test only
  to reproduce a reported bug or when asked.
- Once those checks pass, stop. Broaden or repeat testing only when new changes,
  failures or unresolved concerns justify it.
- Stop exploring as soon as you can name the exact change. Widen the search once at most;
  read only code you will change or call.
- Make the smallest change that solves the request. Mention adjacent improvements; don't
  make them. No new abstractions, options, files or checklists unless asked.
- If an instruction seems to conflict with the user's request, follow the request and
  say so in one line. Don't deliberate.
- Final report: at most 5 lines covering what changed, the commands run, and what's left.
