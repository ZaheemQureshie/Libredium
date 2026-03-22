# Libredium

**Read Medium Without Limits** — A premium, high-fidelity article retrieval platform designed to bypass restricted-access paywalls for educational and research purposes.

---

## 📖 The Purpose

In the modern digital landscape, knowledge is often locked behind paywalls that create a "digital divide" in information accessibility. **Libredium** was developed as a technical response to these barriers, serving as a gateway for researchers, students, and lifelong learners to access high-quality journalism and technical literature without financial restriction.

Our mission is simple: **Information wants to be free.** By leveraging advanced crawler spoofing and content mirroring, Libredium provides a seamless, distraction-free reading experience of Medium member-only articles, formatted elegantly with the Raleway typography.

## 🛠️ How It Works (The Technical Logic)

Libredium doesn't just "fetch" a page; it implements a sophisticated **Bypass Chain** designed to exploit common bypass vulnerabilities and metadata exposure in modern web architectures.

### 1. The Bypass Chain (Heuristics)
The engine executes a sequential failover logic until it finds an open window:
- **Crawler Spoofing (Phase 1):** We leverage the fact that most paywalled platforms want to be indexed by search engines. By spoofing the `Googlebot` User-Agent and injecting legitimate crawler headers (`X-Forwarded-For`), we can often retrieve the full article body that is hidden from standard users.
- **Micro-Mirrors (Phase 2):** If spoofing fails, the service rotates through verified "read-only" mirror protocols (Freedium, Scribe, ReadMedium) to retrieve cached or unblocked versions of the document.
- **Ancestral Snapshots (Phase 3):** As a final resort, the engine queries the Wayback Machine (Archive.org) API for recent closes-proximity snapshots.

### 2. Intelligent Content Reconstruction
Once raw HTML is retrieved, it is processed via **Cheerio** (a fast, flexible implementation of core jQuery for the server):
- **DOM Sanitization:** We programmatically strip out `meteredContent` wrappers, paywall scripts, and intrusive ad-tracking objects.
- **Deep Proxying (Hotlink Bypass):** Medium implements strict hotlinking protections for its high-res images. Libredium solves this by proxying every image through its own `/api/image` endpoint, stripping the referral headers that would otherwise block the request.
- **Synthesis:** The final result is a clean JSON object containing the article's core logic, metadata, and body, ready for the Raleway frontend.
---

## ⚖️ Disclaimer & Ethical Note

This project is a technical proof-of-concept intended for **educational and research purposes only**. 

The maintainers of Libredium respect the hard work of writers and journalists. We encourage users to support their favorite creators by subscribing to their platforms if they can afford to do so. This tool is intended for those who are temporarily or structurally barred from accessing information, not for the commercial exploitation of copyrighted material.


