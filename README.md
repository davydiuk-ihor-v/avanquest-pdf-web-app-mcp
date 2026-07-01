# Avanquest PDF Viewer — Claude Desktop Extension

View and edit PDF files directly inside Claude Desktop. The viewer renders inline in the chat window; Claude can read, annotate, reformat, and save the document through a rich set of tools — no separate application needed.

Powered by [@avanquest/pdf-web-viewer](https://developers.avanquest.com).

---

## Requirements

- **Claude Desktop** (macOS or Windows) with MCP extension support
- **Node.js 20 or later**
- **Avanquest PDF license key** — required to activate the viewer engine. Obtain one at [developers.avanquest.com](https://developers.avanquest.com).

---

## Setup

1. Install the extension from the Claude Desktop extension directory.
2. When prompted, enter your **Avanquest PDF license key**.
3. Optionally set a **default folder** — the directory Claude is allowed to open PDFs from. If left empty, the extension defaults to your `Documents`, `Downloads`, `Desktop`, and `PDF` folders.

---

## What You Can Do

### Open & View
| Tool | Description |
|------|-------------|
| `display_pdf` | Open a local PDF or a remote PDF URL inline in the chat |
| `get_view_state` | Read the current page number, total page count, and file path |
| `set_view_state` | Navigate to a specific page |
| `get_page_image` | Render any page as a PNG image for visual inspection |
| `close_document` | Close the current document |

### Search
| Tool | Description |
|------|-------------|
| `search_in_pdf` | Full-text search — highlights matches and returns their page numbers |
| `navigate_search_result` | Step through results forward or backward |
| `circle_text` | Draw a rectangle or oval around every occurrence of a phrase |

### Read & Extract
| Tool | Description |
|------|-------------|
| `read_text` | Extract all text from the document |
| `read_document_information` | Read title, author, page count, file size, dates, and flags |
| `read_page_info` | Read width, height, and rotation of a specific page |
| `read_annotations` | List all annotations on a page or the whole document |
| `read_bookmarks` | Read the full table of contents |
| `read_form_fields` | List all AcroForm fields with their current values |
| `read_page_text_blocks` | List editable text blocks by index for targeted editing |
| `get_selection_info` | Read the currently selected text and its font attributes |
| `extract_images` | Save all embedded images as a ZIP archive |
| `export_comments` | Export all annotations as an FDF file |

### Edit Text & Formatting
| Tool | Description |
|------|-------------|
| `replace_text` | Find and replace text across pages |
| `format_text` | Apply font size, family, bold, italic, color, highlight, underline, strikethrough to a text fragment |
| `format_selected_text` | Apply formatting to the currently selected text |
| `add_text_to_page` | Add a plain text label or heading to any page |
| `delete_text_blocks` | Delete editable text blocks by index |
| `update_document_properties` | Update title, author, subject, and keywords |

### Page Operations
| Tool | Description |
|------|-------------|
| `insert_blank_page` | Insert a blank page at any position |
| `delete_pages` | Delete one or more pages |
| `move_pages` | Move pages to a different position |
| `duplicate_pages` | Duplicate pages and insert copies |
| `reverse_pages` | Reverse the page order |
| `rotate_pages` | Rotate pages by 90°, 180°, or 270° |
| `resize_pages` | Change page canvas size (A4, Letter, or custom pt dimensions) |
| `extract_pages` | Save a subset of pages as a new PDF |

### Annotations
| Tool | Description |
|------|-------------|
| `add_annotation` | Add a shape annotation: oval, rectangle, rhombus, line, arrow |
| `update_annotation` | Change an annotation's color, opacity, or text in place |
| `delete_annotation` | Delete an annotation by page and index |

### Bookmarks
| Tool | Description |
|------|-------------|
| `add_bookmark` | Add a bookmark pointing to a specific page |
| `delete_bookmark` | Delete a bookmark by its path |
| `delete_all_bookmarks` | Remove all bookmarks |

### Forms
| Tool | Description |
|------|-------------|
| `add_form_field` | Add a text box, checkbox, radio button, dropdown, or button |
| `update_form_field` | Set the value of any form field |
| `add_image_to_page` | Insert an image (SVG, URL, or local file) onto a page |

### Save & Convert
| Tool | Description |
|------|-------------|
| `save_pdf` | Save the document (overwrite the original file) |
| `save_as` | Save a copy under a new name or path |
| `compress_pdf` | Reduce file size (quality levels: min → max) |
| `merge_pdf` | Merge multiple PDFs into one |
| `split_pdf` | Split by page ranges or equal chunks |
| `convert_to_images` | Convert all pages to PNG images and save as a ZIP |
| `insert_page_number` | Add page numbers with configurable format, position, and font |

### Security & Redaction
| Tool | Description |
|------|-------------|
| `set_security_permissions` | Password-protect and restrict printing, copying, or editing |
| `apply_redactions` | Permanently burn marked redaction areas into the page |
| `search_and_redact` | Find text and permanently redact all occurrences |

### Cleanup
| Tool | Description |
|------|-------------|
| `delete_watermark` | Remove watermarks from a page range |
| `delete_header` | Remove headers and footers |
| `delete_page_number` | Remove page numbers |
| `delete_bates_numbering` | Remove Bates numbering |

### Undo / Redo
| Tool | Description |
|------|-------------|
| `undo` | Undo the last in-viewer action |
| `redo` | Redo the last undone action |

---

## Security & File Access

The extension serves PDF files through a local HTTP server bound to `127.0.0.1` only — it is never reachable from the network. Claude can only open files inside the configured allowed folders; any path outside those roots is rejected. Symlinks are resolved before the check so a link cannot escape the allowlist.

Your license key is stored locally by Claude Desktop (`sensitive: true` in the extension config) and is never logged or transmitted anywhere other than the Avanquest license-validation endpoint.

---

## Privacy Policy

**Full policy:** [https://developers.avanquest.com/privacy-policy](https://developers.avanquest.com/privacy-policy)

### Data Collection

This extension does **not** collect, store, or transmit your PDF content, file paths, annotations, or any document data. All PDF processing happens locally on your machine.

### License Validation

The PDF rendering engine validates your license key by making an HTTPS request to `api-developers.avanquest.com`. This request includes your license key and basic environment metadata (platform, library version). No document content is included in this request.

### Local HTTP Server

A temporary HTTP server is started on `127.0.0.1` (localhost) to serve PDF bytes to the in-chat viewer iframe. This server is accessible only from your own machine and is never exposed to the local network or the internet.

### Third-Party Sharing

No data is shared with any third party. The only outbound network call made by this extension is the license validation request to `api-developers.avanquest.com` described above.

### Data Retention

No data is retained after the Claude Desktop session ends. Temporary files created when opening remote PDF URLs are deleted automatically when the session closes.

### Contact

For privacy inquiries contact: [support@avanquest.com](mailto:support@avanquest.com)

---

## Support

- **Email:** [support@avanquest.com](mailto:support@avanquest.com)
- **Documentation:** [https://developers.avanquest.com](https://developers.avanquest.com)
- **License keys:** [https://developers.avanquest.com](https://developers.avanquest.com)

---

## Developer Notes

### Build

```bash
npm install
npm run build        # builds everything (UI + server)
npm run build:server # TypeScript server only
npm run build:ui     # Vite iframe HTML only
npm run pack         # produces avanquest-pdf-mcp-editor.mcpb
```

### Local run (dev)

```bash
export PWV_LICENSE_KEY=your-key
npm start            # stdio MCP server
```

### Architecture

The extension runs as a single Node.js process with two surfaces:

1. **stdio MCP server** — registers all tools and the `ui://avanquest-pdf-viewer/mcp-app.html` resource.
2. **Local HTTP server** on `127.0.0.1` — serves the viewer's JS chunks, assets (workers, fonts, i18n), and short-lived token-gated PDF files (`/file/<token>`).

The `ui://` resource is a Vite single-file HTML bundle. The iframe's CSP is configured via `_meta.ui.csp` to allow the local HTTP origin.
