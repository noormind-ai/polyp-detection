# CLAUDE.md

## Ongoing -> documents -> decisions log flow

    ongoing/        your own raw draft, any format, local, not committed
    documents/      Claude writes <topic>.md from your ongoing draft, using
                    documents/_template.md -- ask before guessing anything
                    unclear
    decisions.md    one line per topic, Y-statement format: "In the context
                    of [use case], facing [concern], we decided [option] to
                    achieve [quality], accepting [downside]."

Staleness check: at session start, flag anything in ongoing/ untouched for
~7 days and ask if it's ready to promote.
