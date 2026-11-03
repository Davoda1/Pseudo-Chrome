# Website examples

These are optional website samples. Pseudo-Chrome does **not** copy them into
the installed `www` directory automatically.

Back up any existing website before trying an example. Open **⋮ → Settings →
Website** and use the app's website-folder action to locate your `www` directory.
Copy the **contents** of one example directory into `www`, not the enclosing
example directory. Keep only the example you are trying active there.

Site settings belong in the application's **parent configuration directory**:

```text
Pseudo-Chrome/
  site.json        ← application hosting configuration
  www/
    index.html     ← website files, or the example's backend files
```

On Windows this is `%AppData%\Pseudo-Chrome\site.json`; on Linux it is
`~/.config/Pseudo-Chrome/site.json`. Use the Settings screen to apply the values
below. If editing `site.json` directly, close the application first, edit the
file, then reopen it. **Do not put `site.json` inside `www`.**

## Static single-page application

Copy the contents of `static-spa/` into `www`. Set:

```json
{
  "mode": "static",
  "documentRoot": ".",
  "spa": true
}
```

The Overview and Details links use normal URL paths and the History API. Open
Details, reload, and use back/forward to check SPA routing. All assets are local.
This example is already deployment-ready and requires no npm installation.

## Node.js HTTP application

Copy `node-http/package.json` and `node-http/server.cjs` into `www`. Set:

```json
{
  "mode": "node",
  "documentRoot": ".",
  "npmScript": "start",
  "entry": "",
  "args": [],
  "env": {},
  "spa": false
}
```

The package has no external dependencies: bundled Node.js and npm are enough.
Its server listens on the launcher's `HOST` and `PORT` environment variables.
The page demonstrates a JSON API, a POST form, and the current Node version.
You can alternatively set `entry` to `server.cjs` and leave `npmScript` empty.

## PHP forms and sessions

Copy `php-forms/index.php` into `www`. Set:

```json
{
  "mode": "php",
  "documentRoot": ".",
  "entry": "",
  "spa": false
}
```

Enter a display name, submit, then reload. The name and visit counter are held
in a PHP session. No database or external dependencies are required. The example
uses Post/Redirect/Get and escapes submitted text before displaying it.
The hosting runtime stores PHP session files under the app's configuration
directory; clearing website cookies creates a new browser session.

## Native C++ HTTP application

`native-cpp/` contains a small cross-platform HTTP server source. Compile it
yourself **before** copying its executable into `www`; Pseudo-Chrome does not
compile backend source code. The server binds to the fixed loopback interface
`127.0.0.1` on the supplied `PORT`. It demonstrates the native-process contract, not a production
HTTP implementation.

Linux with a C++ compiler:

```sh
g++ -std=c++17 -O2 server.cpp -o native-server
```

Windows from a Visual Studio Developer Command Prompt:

```bat
cl /std:c++17 /O2 /MT /EHsc server.cpp /Fe:native-server.exe /link ws2_32.lib
```

Or Windows with MinGW-w64:

```sh
g++ -std=c++17 -O2 -static server.cpp -o native-server.exe -lws2_32
```

Copy only the compiled executable and any runtime files your compiler requires
into `www`. Then set:

```json
{
  "mode": "native",
  "documentRoot": ".",
  "entry": "native-server",
  "args": [],
  "env": {},
  "spa": false
}
```

Use `"entry": "native-server.exe"` on Windows. This sample has no database,
background workers or dependencies beyond the compiled binary's platform
runtime. For real projects, preserve their deployment files and configuration.

## Switching examples

Stop the website before replacing its files, choose the matching mode/settings,
and restart it. `auto` also recognizes the first three layouts, but the explicit
settings above make the selected behavior clear. Database services, credentials,
Apache `.htaccess` files and custom server rules are not reproduced by these
samples. The bundled manual’s Website types and Configuration chapters describe
the supported hosting behavior and limits.
