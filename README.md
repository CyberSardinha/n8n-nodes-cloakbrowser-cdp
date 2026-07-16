# n8n-nodes-cloakbrowser-cdp

Execute Playwright code in n8n by connecting to CloakBrowser via Chrome DevTools Protocol (CDP).

The node uses CloakBrowser's official `cloakbrowser/human` module when humanization is enabled. The browser can run in a different container from n8n; no CloakBrowser binary is started inside the n8n container.

Perfect for:
- Connecting to antidetect browsers (Dolphin Anty, AdsPower, GoLogin, etc.)
- Browser automation with existing browser sessions
- Web scraping with stealth capabilities

## Installation

### Community Nodes (Recommended)

1. Go to **Settings > Community Nodes**
2. Select **Install**
3. Enter `n8n-nodes-cloakbrowser-cdp`
4. Agree to the risks and click **Install**

### Manual Installation

```bash
npm install n8n-nodes-cloakbrowser-cdp
```

## Usage

### 1. Start CloakBrowser in CDP server mode

Run CloakBrowser separately and expose its CDP port:

```bash
docker network create automation

docker run -d --name cloakbrowser \
  --network automation \
  cloakhq/cloakbrowser cloakserve
```

If n8n is on the same Docker network, use `http://cloakbrowser:9222` in the node. If the containers are on different networks, publish the port and use the host address reachable from n8n (for example `http://host.docker.internal:9222` on Docker Desktop):

The n8n container must also be attached to the `automation` network for the service name to resolve.

```bash
docker run -d --name cloakbrowser \
  -p 127.0.0.1:9222:9222 \
  cloakhq/cloakbrowser cloakserve
```

The endpoint should respond to `GET /json/version` before the n8n node runs.

### 2. Configure the CDP endpoint

Start your browser with remote debugging enabled or get the CDP URL from your antidetect browser:

**Chrome/Chromium:**
```bash
google-chrome --remote-debugging-port=9222
```

**Antidetect browsers:**
- Dolphin Anty: Profile settings → Get CDP URL
- AdsPower: Local API → Get debug port
- GoLogin: Profile → Remote debugging

### 3. Configure Node

- **CDP Endpoint URL**: The URL reachable from the n8n container (e.g., `http://cloakbrowser:9222`)
- **JavaScript Code**: Your Playwright automation code
- **Emulate Human Behavior**: Enable CloakBrowser's native human-like mouse movements, typing, scrolling, locators, frames, and element handles
- **Humanize Preset**: Choose `Default` or the slower, more deliberate `Careful` preset
- **Options**: Connection/execution timeouts, proxy/GeoIP connection settings, and session cleanup behavior

For a direct `cloakserve` endpoint, **Proxy URL** and **GeoIP** are added to the
CDP URL automatically. A proxy can be an HTTP or SOCKS5 URL. For CloakBrowser
Manager, configure proxy, GeoIP, and headless mode on the profile before
launching it; the node connects to an already-running profile and cannot change
its launch-time headless setting.

Set **Options → Session Cleanup** to **Disconnect Only** when using CloakBrowser
Manager and you want later nodes to reuse the same running profile and open pages.
Use **Close Browser** at the end of the workflow to terminate the remote session.

### 4. Write Code

Available variables in your code:

| Variable | Description |
|----------|-------------|
| `$playwright` | Playwright library |
| `$browser` | Connected browser instance |
| `$context` | Browser context |
| `$helpers` | Helper functions (see below) |
| `$input` | Input data from previous node |
| `$json` | Shortcut for `$input.item.json` |
| `$binary` | Binary data from previous node |
| `$humanized` | `true` when CloakBrowser's native humanization is enabled |

## Helper Functions

### Screenshot
```javascript
const page = await $context.newPage();
await page.goto('https://example.com');

const screenshot = await $helpers.screenshot(page, {
  fullPage: true,
  type: 'png'
});

return { binary: { screenshot } };
```

### PDF Generation
```javascript
const page = await $context.newPage();
await page.goto('https://example.com');

const pdf = await $helpers.pdf(page, {
  format: 'A4',
  printBackground: true
});

return { binary: { document: pdf } };
```

### Download File
```javascript
// By URL
const file = await $helpers.download('https://example.com/file.pdf');

// By clicking element
const page = await $context.newPage();
await page.goto('https://example.com');
const file = await $helpers.download(page, {
  clickSelector: '#download-btn'
});

return { binary: { file } };
```

### Upload File
```javascript
const page = await $context.newPage();
await page.goto('https://example.com/upload');

// Get file from previous node
const file = await $helpers.binaryToFile('data');

// Upload to input[type="file"]
await $helpers.upload(page, file, {
  selector: '#file-input'
});
```

### Request Interception
```javascript
const page = await $context.newPage();

// Intercept and modify requests
await $helpers.interceptRequests(page, '**/api/**', async (route, request) => {
  // Block request
  // await route.abort();

  // Modify and continue
  await route.continue({
    headers: { ...request.headers(), 'X-Custom': 'value' }
  });
});

await page.goto('https://example.com');
```

### Page Snapshot
```javascript
const page = await $context.newPage();
await page.goto('https://example.com');

// Get accessibility tree (like Playwright MCP)
const snapshot = await $helpers.snapshot(page);

return { snapshot };
```

Output:
```
### Page
- URL: https://example.com
- Title: Example Domain

### Accessibility Tree
- heading "Example Domain"
- paragraph "This domain is for use in illustrative examples..."
- link "More information..."
```

## Human Emulation

When **Emulate Human Behavior** is enabled, the node calls CloakBrowser's native `patchBrowser()` after connecting over CDP. This patches existing pages and all pages/contexts created by the workflow:

- `page.click()` and locator clicks use Bezier curves, realistic aim points, and click timing
- `page.type()` / `page.fill()` type with per-character timing and thinking pauses
- scrolling, hover, keyboard, frames, and element handles use the same native humanization layer

```javascript
// With human emulation enabled:
const page = await $context.newPage();
await page.goto('https://example.com');

// This click will have human-like mouse movement
await page.click('#login-button');

// This will type with realistic delays
await page.type('#username', 'user@example.com');

// Native per-call overrides are also supported:
await page.fill('#message', 'Hello', {
  human_config: { typing_delay: 100 }
});
```

## Examples

### Basic Navigation
```javascript
const page = await $context.newPage();
await page.goto('https://example.com');

const title = await page.title();
const content = await page.textContent('h1');

await page.close();
return { title, content };
```

### Form Submission
```javascript
const page = await $context.newPage();
await page.goto('https://example.com/login');

await page.fill('#email', 'user@example.com');
await page.fill('#password', 'secret');
await page.click('button[type="submit"]');

await page.waitForURL('**/dashboard');
const welcomeText = await page.textContent('.welcome');

await page.close();
return { welcomeText };
```

### Scraping with Multiple Pages
```javascript
const results = [];

for (const url of $json.urls) {
  const page = await $context.newPage();
  await page.goto(url);

  const data = await page.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content
  }));

  results.push(data);
  await page.close();
}

return results.map(item => ({ json: item }));
```

## Compatibility

Tested with:
- Dolphin Anty
- AdsPower
- GoLogin
- Multilogin
- Regular Chrome/Chromium with `--remote-debugging-port`

## Troubleshooting

### Connection Failed
- Verify browser is running and CDP port is accessible
- Check firewall settings
- For Docker: use `host.docker.internal` instead of `localhost`

### Timeout Errors
- Increase timeouts in Options
- Check network connectivity to target sites

### Human Emulation Not Working
- Ensure checkbox is enabled before execution
- Only affects pages created via `$context.newPage()`

## License

[MIT](LICENSE.md)
