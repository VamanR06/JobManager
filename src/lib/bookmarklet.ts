/** The "Save to JobManager" bookmarklet (no server imports: the /save page builds it in the browser). */

/**
 * Runs in the job page (via the bookmarklet) and returns the posting, or an
 * error message. Workday: its own JSON API, same-site from that page. Other
 * sites: the page's JobPosting JSON-LD, else its title and main text. Plain
 * old JavaScript: it runs in whatever browser the person uses.
 */
export const EXTRACT_SCRIPT = String.raw`function () {
  var clean = function (s) { return (s || "").replace(/\s+/g, " ").trim(); };
  var loc = window.location;
  var host = loc.hostname.toLowerCase();
  var segs = loc.pathname.split("/").filter(Boolean);
  var job = segs.indexOf("job");
  var tenant = null;
  if (/\.myworkdayjobs\.com$/.test(host)) tenant = host.split(".")[0];
  else if (/(^|\.)myworkdaysite\.com$/.test(host)) { var r = segs.indexOf("recruiting"); if (r >= 0 && r + 1 < job) tenant = segs[r + 1]; }
  var fromJsonLd = function () {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    var find = function (n) {
      if (!n || typeof n !== "object") return null;
      if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { var f = find(n[i]); if (f) return f; } return null; }
      var t = n["@type"]; if (t === "JobPosting" || (Array.isArray(t) && t.indexOf("JobPosting") >= 0)) return n;
      return find(n["@graph"]);
    };
    for (var i = 0; i < scripts.length; i++) {
      try {
        var p = find(JSON.parse(scripts[i].textContent || ""));
        if (p && p.description) {
          var org = p.hiringOrganization; var place = p.jobLocation; if (Array.isArray(place)) place = place[0];
          var addr = place && place.address;
          return { title: p.title || null, company: (org && (org.name || org)) || null,
            location: addr ? [addr.addressLocality, addr.addressRegion, addr.addressCountry && (addr.addressCountry.name || addr.addressCountry)].filter(Boolean).join(", ") : null,
            description_html: p.description };
        }
      } catch (e) {}
    }
    return null;
  };
  var fromText = function () {
    var main = document.querySelector("main, [role=main], article") || document.body;
    var h1 = document.querySelector("h1");
    return { title: clean(h1 && h1.textContent) || clean(document.title), company: null, location: null, description_text: (main.innerText || "").trim() };
  };
  var done = function (p) { p.url = loc.href; return p; };
  if (tenant && job >= 1 && job + 1 < segs.length) {
    var end = segs.indexOf("apply", job);
    var path = segs.slice(job, end > job ? end : undefined).join("/");
    var api = "/wday/cxs/" + tenant + "/" + segs[job - 1] + "/" + path;
    return fetch(api, { headers: { Accept: "application/json" }, credentials: "omit" })
      .then(function (r) { if (!r.ok) throw new Error("Workday answered " + r.status); return r.json(); })
      .then(function (b) {
        var i = b.jobPostingInfo || {}; var o = b.hiringOrganization || {};
        if (!i.jobDescription) throw new Error("no description");
        return done({ title: i.title || null, company: o.name || null, location: i.location || null, description_html: i.jobDescription });
      })
      .catch(function () { return done(fromJsonLd() || fromText()); });
  }
  return Promise.resolve(done(fromJsonLd() || fromText()));
}`;

/** The bookmarklet for this JobManager address: read the open page, then open /save with the posting. */
export function bookmarklet(origin: string): string {
  const src = `(function(){var f=${EXTRACT_SCRIPT.replace(/\n\s*/g, " ")};f().then(function(p){var w=window.open(${JSON.stringify(`${origin.replace(/\/+$/, "")}/save#`)}+encodeURIComponent(JSON.stringify(p)),"_blank");if(!w)alert("JobManager: allow pop-ups for this site, then click the bookmark again.");}).catch(function(e){alert("JobManager couldn't read this page: "+e);});})();`;
  return `javascript:${encodeURIComponent(src)}`;
}
