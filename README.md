# 🖼️ ImageView - Visual Studio Code Extension

**ImageView** is a Visual Studio Code extension that provides convenient image previews on hover and an integrated side panel to explore and manage project images.

---

## ✨ Features

- 🖱️ **Hover to Preview**  
  Automatically shows a preview when hovering over an image path (local or URL) in `.js`, `.html`, or `.md` files.

- 🌐 **Supports Remote URLs**  
  Previews images from `http` or `https` sources by temporarily downloading them.

- 💾 **Download & Replace URLs**  
  Converts remote image URLs into local project images. You choose where and under what name to save the image.

- 📂 **Image Library Panel**  
  A visual panel in the Activity Bar that shows all image assets in your project with thumbnails.

- 🔄 **Refreshable Panel**  
  Easily refresh the panel to detect newly added images.

---

## 🚀 How to Use

### 📌 Hover Preview
Hover over any string that ends in an image extension (`.png`, `.jpg`, `.svg`, etc.) to preview it.

Example:
```js
const logo = "./assets/logo.png";
const avatar = "https://example.com/avatar.jpg";
