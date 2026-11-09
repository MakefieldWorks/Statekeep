# Snapshot Context

Each snapshot has a required name and an optional description of up to 2,000
characters. The name remains the compact identifier used for selection and Git
storage. The description explains why the saved configuration matters.

Useful descriptions can include:

- the reason the snapshot was created;
- a test, run, ticket, or change identifier;
- the observed outcome at that point;
- a link or short reference to supporting evidence.

Descriptions are optional so quick checkpoints stay quick. They are immutable
with the snapshot: changing the description later would change the historical
record without changing the saved configuration.

Statekeep displays snapshot descriptions in the chronological timeline, snapshot
comparison header, and affected nodes' history. Markdown and HTML reports
include the description for each saved side. CSV exports add `from_description` and
`to_description` columns to every row so each row keeps its comparison context
when filtered or copied elsewhere. The live `Current project` side has no
snapshot description.

A description records user-supplied context. Statekeep does not infer that the
configuration caused the stated test result or outcome.
