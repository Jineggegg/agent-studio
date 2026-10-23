# Static project apps

Open a project and choose **Apps** from the conversation title bar. Register a
project-relative source directory and output directory. Choose existing static
output, a named npm script, or a Node script with explicit arguments. An optional
HTML scaffold creates a new `index.html` only when that file does not exist.

Review the directory, output path and command before confirming a build. The
confirmation is tied to the configuration revision you saw; editing the
configuration makes earlier confirmations stale. An agent can propose an app
or a build, but the Apps screen still requires a person's review. Build proposals
show the saved configuration snapshot. Revision checks do not freeze project
files: the command uses the files present when it runs.

Executing a build requires Linux bubblewrap. It runs without network access,
with bounded output and execution time, and can be cancelled. Install trusted
dependencies separately before building. On a machine without the sandbox you
can publish already-built static output, but cannot execute builds through this
feature. Build logs are bounded and redact recognized credential patterns.

A successful publication captures an immutable set of bounded static files.
Symlinks and paths outside the output directory are refused. Preview opens in an
opaque-origin sandboxed frame; scripts can render the app but cannot read the
workbench's cookies, submit forms, start workers or contact remote services.
Use relative asset paths. Apps needing an arbitrary backend, external API calls
or shared browser storage are outside this version's preview support.

Preview links are short-lived grants tied to the requesting user, current
project access and published version. Keep them private. Removing an app,
changing its configuration or losing access invalidates previews. No private
apps or user content are included in a new installation.
