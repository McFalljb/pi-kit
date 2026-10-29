# My agent rules

## Operating Rules

1. Think before coding. State assumptions and ask when the request is ambiguous.
2. Keep it simple and make the smallest change that solves the problem.

## Working with agents

### Parent session

- Hand long investigations and implementation to a worker; keep decisions in this session.
- Answer quick lookups directly.

### Child sessions

- Do only the task you were given and report the exact commands you ran.

### Safety and authority

- Never print secrets. Ask before anything that changes production.

## Durable notes (vault)

- Notes live in my vault; each note has frontmatter. Update the project index in place.
