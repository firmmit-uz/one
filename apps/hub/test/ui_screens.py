"""SPA 화면 시험: 로컬 서버(test/ui-server.ts) + Playwright(Chromium) 스크린샷·검사.

실행: python3 test/ui_screens.py  (apps/hub 에서)
결과: test/screens/*.png, test/screens/ui-report.json. 실패 검사가 있으면 종료 코드 1.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HUB = Path(__file__).resolve().parent.parent
SCREENS = HUB / "test" / "screens"
BUNDLE = HUB / "test" / ".ui-server.mjs"
CHROMIUM = "/opt/pw-browsers/chromium"

SCREENS.mkdir(parents=True, exist_ok=True)
report = {"pages": [], "flows": [], "failures": []}


def bundle():
    subprocess.run(
        ["npx", "esbuild", "test/ui-server.ts", "--bundle", "--platform=node", "--format=esm",
         "--target=node22", f"--outfile={BUNDLE}", "--log-level=warning"],
        cwd=HUB, check=True,
    )


def start_server(port, stale=False, autosync=False):
    env = dict(os.environ, PORT=str(port), STALE="1" if stale else "0",
               AUTOSYNC="1" if autosync else "0", NODE_NO_WARNINGS="1")
    proc = subprocess.Popen(["node", str(BUNDLE)], cwd=HUB, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    deadline = time.time() + 15
    while time.time() < deadline:
        line = proc.stdout.readline()
        if "ui-server ready" in line:
            return proc
        if proc.poll() is not None:
            raise RuntimeError("ui-server exited")
    raise RuntimeError("ui-server did not start")


PAGE_CHECKS_JS = """
() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const small = [];
  for (const e of document.querySelectorAll('a, button, select, input, textarea')) {
    if (!vis(e) || e.classList.contains('skip-link')) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) small.push((e.textContent || e.tagName).trim().slice(0, 30) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  const cards = [...document.querySelectorAll('a.card')];
  const badLinks = cards.filter((a) => a.target !== '_blank' || a.rel !== 'noopener noreferrer' || !a.href.startsWith('https://')).map((a) => a.href);
  const disabledWithLink = [...document.querySelectorAll('.card-disabled')].filter((d) => d.querySelector('a') || d.closest('a')).length;
  // #9898A0 를 글자색으로 쓰는 요소
  const greyText = [...document.querySelectorAll('body *')].filter((e) => vis(e) && e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && getComputedStyle(e).color === 'rgb(152, 152, 160)').length;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const junk = [];
  while (walker.nextNode()) { const v = walker.currentNode.textContent.trim(); if (/^(null|undefined|NaN|\[object Object\])$/.test(v)) junk.push(v); }
  return {
    junkText: junk,
    lang: document.documentElement.lang,
    title: document.title,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    smallTargets: small,
    cardLinks: cards.length,
    disabledCards: document.querySelectorAll('.card-disabled').length,
    badLinks, disabledWithLink, greyText,
    iframes: document.querySelectorAll('iframe').length,
    adminTabVisible: !document.querySelector('[data-route=admin]').hidden,
    alerts: [...document.querySelectorAll('[role=alert]')].map((a) => a.textContent.replace(/\\s+/g, ' ').trim()).slice(0, 3),
    logoRight: (() => { const l = document.querySelector('.logo').getBoundingClientRect(); return l.right > window.innerWidth - 40 && l.right <= window.innerWidth && l.top < 60; })(),
  };
}
"""


def shoot(browser, base, name, route, width, height, as_user="admin", lang="ko", fail=None,
          expect_console=(), full_page=True, expect=None):
    ctx = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    headers = {"x-test-as": as_user}
    if fail:
        headers["x-test-fail"] = fail
    ctx.set_extra_http_headers(headers)
    ctx.add_init_script(f"try {{ localStorage.setItem('fm-one-hub.lang', {json.dumps(lang)}); }} catch (e) {{}}")
    page = ctx.new_page()
    console, external = [], []
    page.on("console", lambda m: console.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))
    page.on("request", lambda r: external.append(r.url) if not r.url.startswith(base) else None)
    page.goto(f"{base}/#/{route}")
    page.wait_for_load_state("networkidle")
    page.wait_for_function("() => !document.querySelector('main .loading')", timeout=5000)
    checks = page.evaluate(PAGE_CHECKS_JS)
    path = SCREENS / f"{name}.png"
    page.screenshot(path=str(path), full_page=full_page)
    unexpected = [c for c in console if not any(x in c for x in expect_console)]
    entry = {"name": name, "file": str(path.relative_to(HUB)), "viewport": f"{width}x{height}", "user": as_user, "lang": lang,
             "console_errors": console, "unexpected_console_errors": unexpected, "external_requests": external, **checks}
    problems = []
    if unexpected:
        problems.append(f"console errors: {unexpected}")
    if external:
        problems.append(f"external requests: {external}")
    if checks["overflowX"] > 0:
        problems.append(f"horizontal overflow {checks['overflowX']}px")
    if checks["smallTargets"]:
        problems.append(f"small targets: {checks['smallTargets']}")
    if checks["badLinks"] or checks["disabledWithLink"] or checks["iframes"]:
        problems.append("link/iframe rule violated")
    if checks["junkText"]:
        problems.append(f"stray text nodes: {checks['junkText']}")
    if checks["greyText"]:
        problems.append(f"#9898A0 used as text color on {checks['greyText']} elements")
    if not checks["logoRight"]:
        problems.append("logo not at top right")
    if checks["lang"] != lang:
        problems.append(f"html lang {checks['lang']} != {lang}")
    if expect:
        problems += expect(page, checks)
    entry["problems"] = problems
    report["pages"].append(entry)
    for p in problems:
        report["failures"].append(f"{name}: {p}")
    ctx.close()


def flow_revoke(browser, base):
    """관리 화면에서 회수 → 확인 → 목록 갱신, 키보드 포커스 표시 확인."""
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.set_extra_http_headers({"x-test-as": "admin"})
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(f"{base}/#/admin")
    page.wait_for_selector("text=Aziz Karimov")
    row = page.locator("tr", has_text="staff1@example.test")
    before = row.locator(".badge", has_text="회수됨").count()
    row.get_by_role("button", name="회수", exact=True).first.click()
    page.get_by_role("button", name="회수 확인").click()
    page.wait_for_selector(".toast >> text=저장되었습니다")
    page.wait_for_function("() => [...document.querySelectorAll('tr')].some(r => r.textContent.includes('staff1@example.test') && r.textContent.includes('회수됨'))")
    after = page.locator("tr", has_text="staff1@example.test").locator(".badge", has_text="회수됨").count()
    audit = page.evaluate("async () => (await (await fetch('/api/admin/audit?limit=1')).json()).entries[0].action")
    verify = page.evaluate("async () => (await (await fetch('/api/admin/audit/verify')).json()).ok")
    # 키보드 포커스 표시: 새로 연 페이지에서 Tab 으로 첫 카드까지 이동
    fp = ctx.new_page()
    fp.goto(f"{base}/#/home")
    fp.wait_for_selector("a.card")
    focus = {}
    for i in range(12):
        fp.keyboard.press("Tab")
        focus = fp.evaluate("""() => { const e = document.activeElement; const s = getComputedStyle(e);
          return { tag: e.tagName, cls: e.className, text: (e.textContent||'').trim().slice(0,20), outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor }; }""")
        if focus["cls"] == "card":
            break
    focus["tabs"] = i + 1
    box = fp.evaluate("() => { const r = document.activeElement.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; }")
    fp.screenshot(path=str(SCREENS / "focus-visible-1440.png"),
                  clip={"x": max(0, box["x"] - 16), "y": max(0, box["y"] - 16), "width": box["w"] + 32, "height": box["h"] + 32})
    fp.close()
    # 비관리자 화면 전환에서 관리 탭 숨김 + 서버 거부
    ctx2 = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx2.set_extra_http_headers({"x-test-as": "staff"})
    p2 = ctx2.new_page()
    p2.goto(f"{base}/#/admin")
    p2.wait_for_selector("[role=alert]")
    staff_admin_text = p2.locator("[role=alert]").first.text_content()
    staff_api = p2.evaluate("async () => (await fetch('/api/admin/users')).status")
    ctx2.close()
    result = {"name": "revoke_flow", "revoked_badges_before": before, "revoked_badges_after": after, "last_audit_action": audit,
              "audit_verify_ok": verify, "focus": focus, "console_errors": errors,
              "staff_admin_view": staff_admin_text, "staff_admin_api_status": staff_api}
    probs = []
    if after != before + 1:
        probs.append("revoke did not update list")
    if audit != "grant_revoke" or verify is not True:
        probs.append("audit not recorded/verified")
    if focus.get("cls") != "card" or not focus["outline"].startswith("solid 3px"):
        probs.append(f"no visible focus style on card: {focus}")
    if errors:
        probs.append(f"console errors {errors}")
    if staff_api != 403:
        probs.append("staff admin api not 403")
    result["problems"] = probs
    report["flows"].append(result)
    report["failures"] += [f"revoke_flow: {p}" for p in probs]
    ctx.close()


def main():
    bundle()
    srv = start_server(8801)
    srv_stale = start_server(8802, stale=True)
    srv_auto = start_server(8803, autosync=True)
    base, base_stale, base_auto = "http://127.0.0.1:8801", "http://127.0.0.1:8802", "http://127.0.0.1:8803"
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROMIUM if os.path.exists(CHROMIUM) else None)

            def admin_tab_visible(expected):
                return lambda page, c: [] if c["adminTabVisible"] == expected else [f"admin tab visible={c['adminTabVisible']}"]

            def has_disabled(page, c):
                return [] if c["disabledCards"] >= 3 and c["cardLinks"] >= 8 else [f"cards {c['cardLinks']} disabled {c['disabledCards']}"]

            def expect_alert(code):
                return lambda page, c: [] if any(code in a for a in c["alerts"]) else [f"alert with {code} missing: {c['alerts']}"]

            shoot(browser, base, "home-admin-ko-1440", "home", 1440, 900, expect=lambda p, c: has_disabled(p, c) + admin_tab_visible(True)(p, c))
            shoot(browser, base, "home-admin-ko-390", "home", 390, 844)
            shoot(browser, base, "status-admin-ko-1440", "status", 1440, 900)
            shoot(browser, base, "admin-ko-1440", "admin", 1440, 900)
            shoot(browser, base, "admin-ko-390", "admin", 390, 844)
            shoot(browser, base, "home-staff-uz-1440", "home", 1440, 900, as_user="staff", lang="uz-Latn", expect=admin_tab_visible(False))
            shoot(browser, base, "home-staff-ru-390", "home", 390, 844, as_user="staff", lang="ru")
            shoot(browser, base, "status-staff-ru-390", "status", 390, 844, as_user="staff", lang="ru")
            shoot(browser, base, "me-staff-ko-390", "me", 390, 844, as_user="staff")
            shoot(browser, base, "status-error-ko-1440", "status", 1440, 900, as_user="staff", fail="status",
                  expect_console=("status of 500",), expect=expect_alert("internal_error"))
            shoot(browser, base, "error-not-registered-ko-390", "home", 390, 844, as_user="stranger",
                  expect_console=("status of 403",), expect=expect_alert("not_registered"))
            shoot(browser, base_stale, "home-stale-ko-1440", "home", 1440, 900, as_user="staff", full_page=False,
                  expect=lambda p, c: [] if p.locator(".alert-warn").count() == 1 else ["stale banner missing"])
            # WP1: 자동 동기화가 켜진 관리 화면 (수동 입력란은 닫히고 실패 사유가 보인다)
            shoot(browser, base_auto, "admin-sync-auto-ko-1440", "admin", 1440, 900,
                  expect=lambda p, c: ([] if p.locator("text=api_http_403").count() == 1 else ["sync failure code missing"])
                  + ([] if p.locator("textarea").count() == 0 else ["manual snapshot form still open"]))
            shoot(browser, base_auto, "admin-sync-auto-ru-390", "admin", 390, 844, lang="ru")
            flow_revoke(browser, base)
            browser.close()
    finally:
        for s in (srv, srv_stale, srv_auto):
            s.terminate()
            s.wait(timeout=5)
    (SCREENS / "ui-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"pages": len(report["pages"]), "flows": len(report["flows"]), "failures": report["failures"]}, ensure_ascii=False, indent=2))
    for p in report["pages"]:
        print(f"- {p['name']}: console={len(p['console_errors'])} unexpected={len(p['unexpected_console_errors'])} overflowX={p['overflowX']} small={len(p['smallTargets'])} problems={p['problems']}")
    sys.exit(1 if report["failures"] else 0)


if __name__ == "__main__":
    main()
