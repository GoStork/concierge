const H = { "User-Agent": "Mozilla/5.0 (compatible; GoStork/1.0)", Accept: "image/*" };
const CH = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", Accept: "image/*" };
const urls = [
  ["gcs", "https://storage.googleapis.com/gostork-recordings/profile-photos/9c866ef6d78378f559554f625a80c4a8.jpg"],
  ["shadygrove", "https://www.shadygrovefertility.com/wp-content/uploads/2021/03/Wende-Allen.jpg"],
  ["shadygrove2", "https://www.shadygrovefertility.com/wp-content/uploads/2024/06/A.-Gannon-850x850-1.png"],
  ["iflg", "https://www.iflg.net/wp-content/uploads/IFLG-Freshta-Ahmadi-600x600.jpg"],
  ["stl", "https://www.stlfertility.com/quality_auto/DSC01062.jpg"],
  ["framer", "https://framerusercontent.com/images/aNJrL9RYtCKVy9QyolcDthJBg.jpg?width=600&amp;height=900"],
];
for (const [label, u] of urls) {
  for (const [hl, h] of [["proxyUA", H], ["chromeUA", CH]] as any) {
    for (const m of ["HEAD", "GET"]) {
      try {
        const r = await fetch(u, { method: m, headers: h, redirect: "follow", signal: AbortSignal.timeout(15000) });
        const len = m === "GET" ? (await r.arrayBuffer()).byteLength : "-";
        console.log(`${label.padEnd(12)} ${hl.padEnd(9)} ${m.padEnd(5)} ${r.status} ct=${(r.headers.get("content-type")||"").slice(0,30)} len=${len}`);
      } catch (e: any) { console.log(`${label.padEnd(12)} ${hl.padEnd(9)} ${m.padEnd(5)} ERR ${e.message}`); }
    }
  }
}
