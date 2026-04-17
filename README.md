# ⚰️ Tab Cemetery Manager

**Tab Cemetery Manager** is a powerful Chrome extension that helps you manage tab overload using advanced AI. Instead of just grouping tabs by website, it uses **Gemini 3 Flash** to understand what your pages are actually about and organizes them into meaningful "Major Domains."

![Tab Cemetery Preview](tab-cemetery/icons/icon-128.png)

## 🚀 Features

-   **AI-Powered Clustering**: Groups tabs semantically based on page content, not just origin domains.
-   **Contextual Relevance**: Ask the AI "What am I working on?" to find relevant tabs and safely close the rest.
-   **Content Extraction**: Scans titles, H1 tags, and meta-descriptions to provide Gemini with high-fidelity context.
-   **Session snapshots**: Save, export (Markdown/JSON), and bulk-bookmark your tab sessions.
-   **Privacy-First**: Dedicated Privacy Mode and domain exclusion list to keep your sensitive browsing local.
-   **Performance Focused**: Optimized model chain with automatic fallback to ensure responsiveness.

## 🛠️ Installation

### 1. Prerequisites
-   A Google Gemini API Key. You can get one for free at [Google AI Studio](https://aistudio.google.com/app/apikey).
-   Google Chrome version 116 or higher.

### 2. Load the Extension
1.  Download or clone this repository to your local machine:
    ```bash
    git clone https://github.com/EAGV3-SJK/002_tab_cemetery.git
    ```
2.  Open Chrome and navigate to `chrome://extensions`.
3.  Enable **Developer mode** (toggle in the top right).
4.  Click **Load unpacked**.
5.  Select the `tab-cemetery` folder from this repository.

### 3. Configuration
1.  Click the extension icon in your toolbar to open the side panel.
2.  Click the gear icon (⚙️) to open Settings.
3.  Paste your **Gemini API Key** and click **Save**.

## 🧠 Technology Stack
-   **Backend**: Chrome Extension Manifest V3 (Service Workers).
-   **AI**: Gemini API (`gemini-3-flash-preview`).
-   **UI**: Vanilla JavaScript & CSS (Side Panel API).

## 📄 License
MIT License. See [LICENSE](LICENSE) for more details.

---
Built as part of the EAGV3 Assignment 002.
