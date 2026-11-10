# Deliverables: files an agent hands in

A working copy is deleted by cleanup, and a branch holds only what was committed. A report, a screenshot or a built
archive that the owner should look at would be lost, so a session hands it in with a command and the card lists it.
The code is `orc/deliverables.py`, `orc/api/deliverables.py` and `web/src/components/DeliverablesSection.tsx`.

## The command

    orc task attach FILE... [--name NAME]

Like `done`, it takes no card number: it finds the card from the working folder, reads that card's secret and calls
`POST /api/hooks/tasks/{id}/deliverables` with it in `X-Orc-Hook`. A chat or another card's session is refused. A
server older than the CLI answers 404, and the command says to hand in the way the prompt says. The allow rule for
`attach` is added to the session's settings next to `done` and `fail`.

## Storage

The bytes go to the attachment store (`<data>/attachments`), named by the hash of the content with a neutral `.bin`
extension, so they outlive the working copy and the card's branch. A `deliverables` row ties a stored file to a card
under a name and a version. Handing in the same name again makes the next version and the old ones stay. The same
bytes under the same name again are not a new version. Deleting the card deletes its rows; the stored file stays, as
for any attachment. Files count toward `attachments_max_total_mb`.

## Limits

20 MB a file and 100 versions a card. The type comes from an allowlist of extensions: images (png, jpg, gif, webp),
plain text (txt, log, md, csv, tsv, json, yaml, toml, diff, patch), pdf, zip, tar, gz and tgz, and html, htm, svg and xml.
An image must start with its format's signature. Anything else is refused with the list.

## Why a file cannot run

The owner opens these files from the dashboard, on the origin of the orchestrator, whose API holds the dashboard
token. A script from an agent's file on that origin could act as the owner. Three layers stop it:

1. HTML, SVG and XML are accepted but stored as `application/octet-stream` and always sent as `attachment`.
2. Only images and plain text are ever sent `inline`, and only when the page asks (`?inline=1`). The page shows an
   image through `<img>` and text through `<pre>`, never as markup.
3. Every response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: … sandbox`.

The old `GET /api/attachments/{id}` serves only the images pasted into task text, so a handed-in file cannot be
reached through it.

## The card

`GET /api/tasks/{id}/deliverables` returns one entry per name, with all versions newest first. The card shows a
"Files" section in the right column, hidden until there is a file, built on `SidebarSection`. A row opens a window
with the preview, the version switch and a download button.
