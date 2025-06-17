const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const remoteImageCache = new Map();
const tempFilesToDelete = [];

class ImageLibraryProvider {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: vscode.workspace.workspaceFolders?.map(f => f.uri) || []
    };

    this._render(webviewView.webview);
  }

  async _render(webview) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;

    const imageFiles = [];
    const exts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg'];

    const scanDir = dir => {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
          scanDir(full);
        } else if (exts.includes(path.extname(full).toLowerCase())) {
          imageFiles.push(full);
        }
      }
    };

    for (const folder of workspaceFolders) {
      scanDir(folder.uri.fsPath);
    }

    const html = `
      <html>
      <body style="padding: 10px; font-family: sans-serif;">
        <button onclick="refresh()">🔄 Refresh</button>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, 100px); gap: 10px; margin-top: 10px;">
          ${imageFiles.map(file => {
            const webviewUri = webview.asWebviewUri(vscode.Uri.file(file));
            const rel = vscode.workspace.asRelativePath(file);
            return `
              <div style="text-align: center;">
                <a onclick="open('${file}')"><img src="${webviewUri}" width="80" style="border: 1px solid #ccc;"/></a>
                <div style="font-size: 10px; overflow: hidden;">${rel}</div>
              </div>`;
          }).join('')}
        </div>
        <script>
          const vscode = acquireVsCodeApi();
          function refresh() {
            vscode.postMessage({ command: 'refresh' });
          }
          function open(path) {
            vscode.postMessage({ command: 'open', path });
          }
        </script>
      </body>
      </html>
    `;

    webview.html = html;

    webview.onDidReceiveMessage(msg => {
      if (msg.command === 'refresh') {
        this._render(webview);
      } else if (msg.command === 'open' && msg.path) {
        const fileUri = vscode.Uri.file(msg.path);
        vscode.commands.executeCommand('vscode.open', fileUri);
      }
    });
  }

  refresh() {
    if (this._view) {
      this._render(this._view.webview);
    }
  }
}

function activate(context) {
  console.log('Imageview extension is now active!');

  const hoverProvider = vscode.languages.registerHoverProvider({ scheme: 'file' }, {
    provideHover: async function (document, position) {
      const range = document.getWordRangeAtPosition(position, /(['"])([^'"]+\.(png|jpg|jpeg|gif|svg|webp|ico))\1/);
      if (!range) return;

      const imagePath = document.getText(range).replace(/['"]/g, '');
      console.log(`🖼️ Hover detected on: ${imagePath}`);

      if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        try {
          let tempPath;
          if (remoteImageCache.has(imagePath)) {
            tempPath = remoteImageCache.get(imagePath);
          } else {
            tempPath = await downloadImageToTemp(imagePath);
            remoteImageCache.set(imagePath, tempPath);
            tempFilesToDelete.push(tempPath);
          }

          const uri = vscode.Uri.file(tempPath).toString();
          const markdown = createImageMarkdown(
            uri,
            '200',
            vscode.Uri.file(tempPath),
            imagePath,
            document,
            { line: position.line, character: position.character }
          );
          return new vscode.Hover(markdown, range);
        } catch {
          return new vscode.Hover(new vscode.MarkdownString(`⚠️ **Could not load:** ${imagePath}`), range);
        }
      }

      const fileUri = document.uri;
      const currentDir = path.dirname(fileUri.fsPath);
      const absoluteImagePath = path.resolve(currentDir, imagePath);

      if (fs.existsSync(absoluteImagePath)) {
        const uri = vscode.Uri.file(absoluteImagePath).toString();
        return new vscode.Hover(createImageMarkdown(uri, '200', vscode.Uri.file(absoluteImagePath)), range);
      } else {
        try {
          const base64 = await readImageAsBase64(absoluteImagePath);
          const ext = path.extname(imagePath).substring(1);
          const dataUri = `data:image/${ext};base64,${base64}`;
          return new vscode.Hover(createImageMarkdown(dataUri, '200'), range);
        } catch {
          return new vscode.Hover(new vscode.MarkdownString(`⚠️ Image not found: \`${imagePath}\``), range);
        }
      }
    }
  });
  context.subscriptions.push(hoverProvider);

  const downloadFromHover = vscode.commands.registerCommand("imageview.downloadAndReplaceFromHover", async (args) => {
    const { url, documentUri, position } = args;
    if (!url || !documentUri || !position) return;

    const pos = new vscode.Position(position.line, position.character);
    const document = await vscode.workspace.openTextDocument(documentUri);
    const editor = await vscode.window.showTextDocument(document);
    const range = document.getWordRangeAtPosition(pos, /(['"])(https?:\/\/[^'"]+\.(png|jpg|jpeg|gif|svg|webp|ico))\1/);
    if (!range) return;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (!workspaceFolder) return;

    const ext = path.extname(url).split('?')[0] || '.png';
    const defaultFileName = `image${ext}`;
    const targetUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, 'images', defaultFileName)),
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'] }
    });
    if (!targetUri) return;

    try {
      await downloadImageToFile(url, targetUri.fsPath);
      const relativePath = path.relative(workspaceFolder.uri.fsPath, targetUri.fsPath).replace(/\\/g, '/');
      editor.edit(editBuilder => {
        editBuilder.replace(range, `"./${relativePath}"`);
      });
      vscode.window.showInformationMessage(`✅ Saved: ./${relativePath}`);
    } catch (err) {
      vscode.window.showErrorMessage(`❌ ${err.message}`);
    }
  });
  context.subscriptions.push(downloadFromHover);

  const imageLibraryProvider = new ImageLibraryProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('imageLibraryPanel', imageLibraryProvider)
  );

  context.subscriptions.push(vscode.commands.registerCommand('imageview.refreshImageLibrary', () => {
    imageLibraryProvider.refresh();
  }));
}

function createImageMarkdown(uri, widthPx, openFileUri, remoteUrl = null, document = null, position = null) {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`![preview](${uri}|width=${widthPx})\n\n`);

  const links = [];

  if (openFileUri) {
    const openUri = `command:vscode.open?${encodeURIComponent(JSON.stringify(openFileUri))}`;
    links.push(`[📂 Open Image File](${openUri})`);
  }

  if (remoteUrl && document && position) {
    const args = { url: remoteUrl, documentUri: document.uri, position };
    const downloadUri = `command:imageview.downloadAndReplaceFromHover?${encodeURIComponent(JSON.stringify(args))}`;
    links.push(`[📥 Download & Replace URL](${downloadUri})`);
  }

  if (links.length > 0) {
    markdown.appendMarkdown(links.join(' | '));
  }

  markdown.supportHtml = true;
  markdown.isTrusted = true;
  return markdown;
}

function readImageAsBase64(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data.toString('base64'));
    });
  });
}

function downloadImageToTemp(url) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(url).split('?')[0] || '.png';
    const fileName = `imageview_${crypto.randomUUID()}${ext}`;
    const tempPath = path.join(os.tmpdir(), fileName);
    const file = fs.createWriteStream(tempPath);
    const client = url.startsWith('https') ? https : http;

    client.get(url, (res) => {
      if (res.statusCode !== 200 || !res.headers['content-type']?.startsWith('image/')) {
        reject(new Error(`Invalid response: ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(tempPath)));
    }).on('error', err => {
      fs.unlink(tempPath, () => reject(err));
    });
  });
}

function downloadImageToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;

    client.get(url, (res) => {
      if (res.statusCode !== 200 || !res.headers['content-type']?.startsWith('image/')) {
        reject(new Error(`Status ${res.statusCode}: not an image`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

function deactivate() {
  for (const tempPath of tempFilesToDelete) {
    fs.unlink(tempPath, () => {});
  }
}

module.exports = {
  activate,
  deactivate
};
