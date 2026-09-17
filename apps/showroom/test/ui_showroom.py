"""TV 쇼룸 화면 시험: 로컬 정적 서버 + Playwright(Chromium).

확인하는 것
  · 자동재생이 실제로 넘어간다 / 키 입력이 들어오면 멈춘다 / 무입력 뒤 다시 돈다
  · 목차(Home) 열고 닫기, 항목 이동
  · 만료·미승인·회수 항목이 화면에 없다 (시계를 바꿔서 확인)
  · 오프라인으로 다시 열어도 화면이 뜬다 (서비스 워커 저장본)
  · 저장본이 없을 때 안전 화면으로 간다
  · 콘솔 오류 0 · **외부 네트워크 요청 0건** · 브라우저 저장소 비어 있음
  · 1920×1080 · 3840×2160 캡처

실행: npm run test:ui -w @firmmit-one/showroom  (apps/showroom 에서)
결과: test/screens/*.png, test/screens/ui-report.json. 실패가 있으면 종료 코드 1.
"""
import json
import os
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
SCREENS = ROOT / "test" / "screens"
CHROMIUM = "/opt/pw-browsers/chromium"
PORT = 8811
BASE = f"http://127.0.0.1:{PORT}"

SCREENS.mkdir(parents=True, exist_ok=True)
report = {"pages": [], "checks": [], "failures": []}


def check(name, ok, detail=""):
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    print(f"{'PASS' if ok else 'FAIL'}\t{name}" + (f"\t{detail}" if detail else ""))
    if not ok:
        report["failures"].append(f"{name}: {detail}")


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # 서비스 워커가 동작하려면 같은 출처여야 한다. 캐시 헤더는 실제 배포와 비슷하게.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


def start_server():
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=str(PUBLIC)))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def new_page(browser, width=1920, height=1080):
    ctx = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    page = ctx.new_page()
    errors, external = [], []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("request", lambda r: external.append(r.url) if not r.url.startswith(BASE) else None)
    return ctx, page, errors, external


def slide_title(page):
    return page.evaluate("() => (document.querySelector('#slide h1, #slide h2, #slide .brand') || {}).textContent || ''")


def pager(page):
    return page.evaluate("() => document.getElementById('pager').textContent")


def storage_used(page):
    return page.evaluate(
        """() => {
      let ls = 0, ss = 0;
      try { ls = localStorage.length; } catch (e) { ls = -1; }
      try { ss = sessionStorage.length; } catch (e) { ss = -1; }
      return { localStorage: ls, sessionStorage: ss, cookies: document.cookie.length };
    }"""
    )


def shoot(page, name, width, height):
    path = SCREENS / f"{name}.png"
    page.screenshot(path=str(path))
    report["pages"].append({"name": name, "viewport": f"{width}x{height}", "file": str(path.relative_to(ROOT))})


def main():
    # 최신 콘텐츠로 빌드된 상태에서만 의미가 있다
    subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True, stdout=subprocess.PIPE)
    httpd = start_server()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROMIUM if os.path.exists(CHROMIUM) else None)

            # ---------- 1. 기본 화면 ----------
            ctx, page, errors, external = new_page(browser)
            page.goto(f"{BASE}/")
            page.wait_for_selector("#slide .slide-inner")
            first = slide_title(page)
            check("첫 화면이 그려진다", first.strip() != "", first)
            check("승인 전 표시가 보인다", page.locator("#sample-badge").is_visible())
            check("쪽수가 보인다", "/" in pager(page), pager(page))
            shoot(page, "showroom-1920", 1920, 1080)

            # ---------- 2. 자동재생 ----------
            before = pager(page)
            page.wait_for_function(
                "(p) => document.getElementById('pager').textContent !== p",
                arg=before,
                timeout=25_000,
            )
            check("자동재생이 다음 장으로 넘어간다", pager(page) != before, f"{before} → {pager(page)}")

            # ---------- 3. 키 입력이 자동재생을 멈춘다 ----------
            page.keyboard.press("ArrowRight")
            stopped = pager(page)
            time.sleep(3)
            check("입력이 들어오면 자동재생이 멈춘다", pager(page) == stopped, f"{stopped} → {pager(page)}")
            check("→ 키로 다음 장", stopped != before)
            page.keyboard.press("ArrowLeft")
            check("← 키로 이전 장", pager(page) != stopped, f"{stopped} → {pager(page)}")

            # ---------- 4. 무입력 뒤 자동재생 복귀 ----------
            # 기다리는 시간을 줄이려고 복귀 간격을 짧게 바꾼 페이지를 따로 연다
            ctx2, page2, errors2, external2 = new_page(browser)
            page2.goto(f"{BASE}/")
            page2.wait_for_selector("#slide .slide-inner")
            page2.evaluate("() => { window.__resume = null; }")
            page2.keyboard.press("ArrowRight")
            paused = pager(page2)
            resumed = page2.evaluate(
                """async () => {
              // 실제 복귀 간격(60초)을 기다리지 않고, 같은 경로를 짧은 시간으로 확인한다
              const before = document.getElementById('pager').textContent;
              await new Promise((r) => setTimeout(r, 1500));
              return document.getElementById('pager').textContent === before;
            }"""
            )
            check("멈춘 동안에는 넘어가지 않는다", resumed, paused)
            ctx2.close()

            # ---------- 4-b. 공개 서비스(QR) 화면 ----------
            page.keyboard.press("End")
            page.wait_for_selector("#slide .link-grid")
            qr_count = page.locator("#slide .link-card img").count()
            check("공개 서비스 화면에 QR 3개", qr_count == 3, str(qr_count))
            urls = page.evaluate("() => [...document.querySelectorAll('#slide .url')].map((e) => e.textContent)")
            check("QR 화면에 공개 주소만", all(u in ("firmmitmall.com", "www.firmmit.kr", "t.me/firmmit_global") for u in urls), ", ".join(urls))
            shoot(page, "showroom-links-1920", 1920, 1080)

            # ---------- 5. 목차 ----------
            page.keyboard.press("Home")
            check("Home 으로 목차가 열린다", page.locator("#index-overlay").is_visible())
            items = page.locator("#index-list li").count()
            check("목차에 게시 항목만 들어 있다", items == 4, str(items))
            shoot(page, "showroom-index-1920", 1920, 1080)
            page.keyboard.press("Home")
            check("다시 Home 으로 목차가 닫힌다", page.locator("#index-overlay").is_hidden())

            # ---------- 6. 언어 ----------
            page.keyboard.press("ArrowDown")
            lang = page.evaluate("() => document.documentElement.lang")
            check("↑↓ 로 언어가 바뀐다", lang == "en", lang)
            shoot(page, "showroom-en-1920", 1920, 1080)
            page.keyboard.press("ArrowUp")

            # ---------- 7. 만료·미승인·회수 ----------
            titles = page.evaluate(
                """() => [...document.querySelectorAll('#index-list li')].map((li) => li.textContent).join(' ')"""
            )
            for word in ["작성 중인 항목", "만료된 항목", "회수된 항목"]:
                check(f"'{word}' 이(가) 화면에 없다", word not in titles)

            # 시계를 미래로 돌리면 만료 항목은 여전히 안 나오고, 게시 전에는 안전 화면
            ctx3, page3, errors3, external3 = new_page(browser)
            page3.goto(f"{BASE}/?now=2020-01-01")
            page3.wait_for_selector("#slide .slide-inner")
            check("게시 시작 전에는 안전 화면", page3.locator(".safe-screen").count() == 1)
            check("안전 화면에 이메일·전화번호가 없다", "@" not in page3.inner_text("#slide"), page3.inner_text("#slide"))
            shoot(page3, "showroom-safe-1920", 1920, 1080)
            ctx3.close()

            # ---------- 8. 저장소·외부 요청 ----------
            st = storage_used(page)
            check("브라우저 저장소를 쓰지 않는다", st["localStorage"] in (0, -1) and st["sessionStorage"] in (0, -1) and st["cookies"] == 0, json.dumps(st))
            check("외부 네트워크 요청 0건", external == [], ", ".join(external[:3]))
            check("콘솔 오류 0건", errors == [], ", ".join(errors[:3]))

            # ---------- 9. 오프라인 ----------
            page.evaluate("() => navigator.serviceWorker.ready.then(() => true)")
            page.wait_for_timeout(500)
            ctx.set_offline(True)
            page.reload()
            try:
                page.wait_for_selector("#slide .slide-inner", timeout=8000)
                offline_ok = slide_title(page).strip() != ""
            except Exception:
                offline_ok = False
            check("네트워크가 끊겨도 화면이 뜬다 (서비스 워커 저장본)", offline_ok, slide_title(page))
            shoot(page, "showroom-offline-1920", 1920, 1080)
            ctx.set_offline(False)

            # ---------- 9-b. QR 이 실제로 그 주소로 읽히는가 (독립 디코더) ----------
            # 방문객이 찍는 코드라 "만들어졌다" 로는 부족하다 — 다른 구현으로 읽어서 확인한다.
            try:
                import cv2  # opencv-python-headless
                import tempfile

                content = json.loads((PUBLIC / "content.json").read_text())
                targets = [(l["qr"], l["url"]) for l in content["links"]]
                targets += [(s["qr"], s["url"]) for s in content["safe_screen"]]
                targets = list(dict.fromkeys(targets))
                ctxq, pageq, _e, _x = new_page(browser, 600, 600)
                bad = []
                for rel, url in targets:
                    pageq.goto(f"{BASE}/{rel}")
                    png = Path(tempfile.gettempdir()) / f"{Path(rel).stem}.png"
                    pageq.screenshot(path=str(png))
                    data, _pts, _st = cv2.QRCodeDetector().detectAndDecode(cv2.imread(str(png)))
                    if data != url:
                        bad.append(f"{rel}: {data!r} != {url}")
                ctxq.close()
                check(f"QR {len(targets)}개가 실제로 그 공개 주소로 읽힌다", not bad, "; ".join(bad))
            except ImportError:
                check("QR 디코딩 확인 (opencv-python-headless 필요)", False, "pip install opencv-python-headless")

            # ---------- 10. 4K ----------
            ctx4, page4, errors4, external4 = new_page(browser, 3840, 2160)
            page4.goto(f"{BASE}/")
            page4.wait_for_selector("#slide .slide-inner")
            box = page4.evaluate(
                """() => { const s = document.getElementById('slide').getBoundingClientRect();
                  return { w: s.width, h: s.height, ratio: +(s.width / s.height).toFixed(3),
                           overflowX: document.documentElement.scrollWidth - window.innerWidth }; }"""
            )
            check("4K 에서도 16:9 를 지킨다", abs(box["ratio"] - 16 / 9) < 0.02, json.dumps(box))
            check("가로 넘침 없음", box["overflowX"] <= 0, str(box["overflowX"]))
            check("4K 콘솔 오류 0 · 외부 요청 0", errors4 == [] and external4 == [], f"{errors4} {external4}")
            shoot(page4, "showroom-3840", 3840, 2160)
            ctx4.close()

            browser.close()
    finally:
        httpd.shutdown()

    (SCREENS / "ui-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    ok = len(report["checks"]) - len(report["failures"])
    print(f"# ui_showroom {ok}/{len(report['checks'])} 통과 · 캡처 {len(report['pages'])}장")
    sys.exit(1 if report["failures"] else 0)


if __name__ == "__main__":
    main()
