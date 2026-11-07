/*
 * pixelpet-desktop-helper.exe — Pixel Pet 桌面壁纸助手 (docs/wallpaper-mode.md §1.1).
 *
 * Puts the app's wallpaper window into the WorkerW behind the desktop icons and keeps it there. Plain Win32 C,
 * user32 / shell32 / wtsapi32 / kernel32 / ntdll only; no hooks, no injection, no network, no files, asInvoker.
 * Built by `npm run build:win-helper` (scripts/build-win-helper.js): cross-compiled with mingw-w64 on Linux (CI:
 * the win-helper job in .github/workflows/release.yml / test.yml), reproducible (no PE timestamp, no build id);
 * its sha256 goes into ../helper.json and src/main/wallpaper/win-helper.js refuses to start any other file.
 *
 * Arguments (for checks only; the app starts it with none):
 *   --version     {"version":"…","arch":"x64"} and exit 0
 *   --self-test   runs the request parser on fixed lines, looks for Progman / WorkerW, prints one JSON report, exit 0
 *
 * Protocol (src/main/wallpaper/win-helper.js): one JSON object per line.
 *   stdin   {"id":1,"cmd":"attach","hwnd":"0x1A2B3C","rect":{"x":0,"y":0,"w":2560,"h":1440}}
 *           {"id":2,"cmd":"place", "hwnd":"…","rect":{…}}
 *           {"id":3,"cmd":"status","hwnd":"…"}
 *           {"id":4,"cmd":"detach","hwnd":"…"}
 *   stdout  {"id":1,"ok":true,"layout":"24h2","workerw":"0x10052"}  |  {"id":1,"error":"no-workerw"}
 *           {"event":"shell-restarted"} {"event":"display-changed"} {"event":"session","locked":true}
 *           {"event":"occluded","on":true,"why":"fullscreen"}
 * stdin closing (the app quit) detaches every window it attached and exits.
 *
 * NOT RUN ON REAL WINDOWS YET (only under wine): see docs §6.2 W1–W8 for the real-machine checks.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wtsapi32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _MSC_VER
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "wtsapi32.lib")
#endif

#define HELPER_VERSION "1.0.0"

#define MAX_ATTACHED 16
typedef struct { HWND hwnd; LONG_PTR style; LONG_PTR exstyle; HWND parent; } Attached;
static Attached g_attached[MAX_ATTACHED];
static int g_count = 0;
static HWND g_workerw = NULL;
static const char *g_layout = "legacy";
static UINT g_taskbarCreated = 0;
static CRITICAL_SECTION g_out;

static void emit(const char *line) {
  EnterCriticalSection(&g_out);
  fputs(line, stdout); fputc('\n', stdout); fflush(stdout);
  LeaveCriticalSection(&g_out);
}

typedef LONG (WINAPI *RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
static DWORD build_number(void) {
  RTL_OSVERSIONINFOW v;
  RtlGetVersionFn f = (RtlGetVersionFn)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  ZeroMemory(&v, sizeof v); v.dwOSVersionInfoSize = sizeof v;
  if (f && f(&v) == 0) return v.dwBuildNumber;
  return 0;
}

/* the older desktop tree: the top-level window that holds SHELLDLL_DefView, and the WorkerW after it */
static BOOL CALLBACK find_defview(HWND top, LPARAM out) {
  HWND dv = FindWindowExW(top, NULL, L"SHELLDLL_DefView", NULL);
  if (dv) { *(HWND *)out = FindWindowExW(NULL, top, L"WorkerW", NULL); return FALSE; }
  return TRUE;
}
static HWND workerw_legacy(void) { HWND w = NULL; EnumWindows(find_defview, (LPARAM)&w); return w; }
/* 24H2 (build >= 26100): the WorkerW is a child of Progman, kept under DefView */
static HWND workerw_24h2(HWND progman) {
  HWND w = FindWindowExW(progman, NULL, L"WorkerW", NULL);
  if (w) SetWindowPos(w, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  return w;
}
static HWND spawn_workerw(void) {
  HWND progman = FindWindowW(L"Progman", NULL);
  DWORD_PTR r = 0;
  if (!progman) return NULL;
  SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, SMTO_NORMAL, 1000, &r);
  SendMessageTimeoutW(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, &r);
  if (build_number() >= 26100) {
    HWND w = workerw_24h2(progman);
    if (w) { g_layout = "24h2"; return w; }
    w = workerw_legacy();
    if (w) g_layout = "legacy";
    return w;
  } else {
    HWND w = workerw_legacy();
    if (w) { g_layout = "legacy"; return w; }
    w = workerw_24h2(progman);
    if (w) g_layout = "24h2";
    return w;
  }
}

static Attached *find(HWND h) { for (int i = 0; i < g_count; i++) if (g_attached[i].hwnd == h) return &g_attached[i]; return NULL; }

/* tiny JSON readers for the one flat message shape above */
static int json_int(const char *s, const char *key, long long *out) {
  char pat[32]; const char *p; snprintf(pat, sizeof pat, "\"%s\":", key);
  p = strstr(s, pat); if (!p) return 0; *out = _strtoi64(p + strlen(pat), NULL, 10); return 1;
}
static int json_str(const char *s, const char *key, char *out, size_t n) {
  char pat[32]; const char *p, *e; snprintf(pat, sizeof pat, "\"%s\":\"", key);
  p = strstr(s, pat); if (!p) return 0; p += strlen(pat); e = strchr(p, '"'); if (!e || (size_t)(e - p) >= n) return 0;
  memcpy(out, p, e - p); out[e - p] = 0; return 1;
}

static void reply_error(long long id, const char *err) { char b[128]; snprintf(b, sizeof b, "{\"id\":%lld,\"error\":\"%s\"}", id, err); emit(b); }

static void do_place(HWND h, RECT r) {
  /* coordinates are relative to the WorkerW's client area, whose origin is the virtual screen's (may be negative) */
  int ox = GetSystemMetrics(SM_XVIRTUALSCREEN), oy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  SetWindowPos(h, NULL, r.left - ox, r.top - oy, r.right - r.left, r.bottom - r.top, SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW);
}

static void handle(const char *line) {
  long long id = 0, x = 0, y = 0, w = 0, hgt = 0; char cmd[16] = {0}, hs[32] = {0}; HWND h; RECT r; char b[256];
  json_int(line, "id", &id);
  if (!json_str(line, "cmd", cmd, sizeof cmd)) { reply_error(id, "bad-request"); return; }
  if (!json_str(line, "hwnd", hs, sizeof hs)) { reply_error(id, "bad-hwnd"); return; }
  h = (HWND)(ULONG_PTR)_strtoui64(hs, NULL, 16);
  if (!IsWindow(h)) { reply_error(id, "bad-hwnd"); return; }
  json_int(line, "x", &x); json_int(line, "y", &y); json_int(line, "w", &w); json_int(line, "h", &hgt);
  SetRect(&r, (int)x, (int)y, (int)(x + w), (int)(y + hgt));

  if (!strcmp(cmd, "attach")) {
    Attached *a = find(h);
    g_workerw = spawn_workerw();
    if (!g_workerw) { reply_error(id, "no-workerw"); return; }
    if (!a && g_count < MAX_ATTACHED) { a = &g_attached[g_count++]; a->hwnd = h; a->style = GetWindowLongPtrW(h, GWL_STYLE); a->exstyle = GetWindowLongPtrW(h, GWL_EXSTYLE); a->parent = GetParent(h); }
    SetWindowLongPtrW(h, GWL_STYLE, (GetWindowLongPtrW(h, GWL_STYLE) & ~WS_POPUP) | WS_CHILD);
    SetWindowLongPtrW(h, GWL_EXSTYLE, GetWindowLongPtrW(h, GWL_EXSTYLE) | WS_EX_NOACTIVATE);
    SetParent(h, g_workerw);
    if (w > 0 && hgt > 0) do_place(h, r);
    if (GetParent(h) != g_workerw) { reply_error(id, "no-workerw"); return; }
    snprintf(b, sizeof b, "{\"id\":%lld,\"ok\":true,\"layout\":\"%s\",\"workerw\":\"0x%llx\"}", id, g_layout, (unsigned long long)(ULONG_PTR)g_workerw);
    emit(b);
  } else if (!strcmp(cmd, "place")) {
    do_place(h, r);
    snprintf(b, sizeof b, "{\"id\":%lld,\"ok\":true}", id); emit(b);
  } else if (!strcmp(cmd, "status")) {
    HWND p = GetParent(h);
    BOOL alive = p && IsWindow(p) && p == g_workerw;
    snprintf(b, sizeof b, "{\"id\":%lld,\"ok\":true,\"attached\":%s,\"parentAlive\":%s,\"visible\":%s,\"layout\":\"%s\"}", id, find(h) ? "true" : "false", alive ? "true" : "false", IsWindowVisible(h) ? "true" : "false", g_layout);
    emit(b);
  } else if (!strcmp(cmd, "detach")) {
    Attached *a = find(h);
    WCHAR wp[MAX_PATH] = {0};
    SetParent(h, NULL);
    if (a) { SetWindowLongPtrW(h, GWL_STYLE, a->style); SetWindowLongPtrW(h, GWL_EXSTYLE, a->exstyle); *a = g_attached[--g_count]; }
    if (g_workerw) RedrawWindow(g_workerw, NULL, NULL, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN);
    /* the system wallpaper draws itself again: no last frame of ours left on the WorkerW */
    if (SystemParametersInfoW(SPI_GETDESKWALLPAPER, MAX_PATH, wp, 0)) SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, wp, SPIF_SENDCHANGE);
    snprintf(b, sizeof b, "{\"id\":%lld,\"ok\":true}", id); emit(b);
  } else reply_error(id, "bad-request");
}

/* occlusion: every 2 s, the notification state and the foreground window against the monitor it is on */
static void check_occlusion(void) {
  static int last = -1; QUERY_USER_NOTIFICATION_STATE q; HWND fg = GetForegroundWindow(); int on = 0; const char *why = "none";
  if (SUCCEEDED(SHQueryUserNotificationState(&q))) {
    if (q == QUNS_RUNNING_D3D_FULL_SCREEN) { on = 1; why = "d3d"; }
    else if (q == QUNS_PRESENTATION_MODE) { on = 1; why = "presentation"; }
    else if (q == QUNS_BUSY) { on = 1; why = "fullscreen"; }
  }
  if (!on && fg) {
    WCHAR cls[64] = {0}; GetClassNameW(fg, cls, 64);
    if (wcscmp(cls, L"Progman") && wcscmp(cls, L"WorkerW")) {
      RECT wr; MONITORINFO mi; ZeroMemory(&mi, sizeof mi); mi.cbSize = sizeof mi;
      if (GetWindowRect(fg, &wr) && GetMonitorInfoW(MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST), &mi)) {
        RECT m = mi.rcMonitor; RECT in; IntersectRect(&in, &wr, &m);
        double cover = (double)(in.right - in.left) * (in.bottom - in.top) / ((double)(m.right - m.left) * (m.bottom - m.top));
        if (EqualRect(&in, &m)) { on = 1; why = "fullscreen"; }
        else if (IsZoomed(fg) && cover >= 0.95) { on = 1; why = "maximized"; }
      }
    }
  }
  if (on != last) { char b[96]; snprintf(b, sizeof b, "{\"event\":\"occluded\",\"on\":%s,\"why\":\"%s\"}", on ? "true" : "false", why); emit(b); last = on; }
}

static LRESULT CALLBACK wndproc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
  if (m == g_taskbarCreated && g_taskbarCreated) { g_workerw = NULL; emit("{\"event\":\"shell-restarted\"}"); return 0; }
  switch (m) {
    case WM_DISPLAYCHANGE: case WM_DPICHANGED: emit("{\"event\":\"display-changed\"}"); return 0;
    case WM_WTSSESSION_CHANGE:
      if (wp == WTS_SESSION_LOCK) emit("{\"event\":\"session\",\"locked\":true}");
      if (wp == WTS_SESSION_UNLOCK) emit("{\"event\":\"session\",\"locked\":false}");
      return 0;
    case WM_TIMER: check_occlusion(); return 0;
  }
  return DefWindowProcW(h, m, wp, lp);
}

static DWORD WINAPI reader(LPVOID unused) {
  char line[1024];
  (void)unused;
  while (fgets(line, sizeof line, stdin)) handle(line);
  /* stdin closed: the app quit — let go of everything and leave */
  for (int i = g_count - 1; i >= 0; i--) { char b[96]; snprintf(b, sizeof b, "{\"id\":0,\"cmd\":\"detach\",\"hwnd\":\"0x%llx\"}", (unsigned long long)(ULONG_PTR)g_attached[i].hwnd); handle(b); }
  ExitProcess(0);
  return 0;
}

/* --self-test: the parser on fixed lines (answers go to stdout like real ones), then what this desktop looks like */
static int g_selftest_errors = 0;
static void expect_int(const char *line, const char *key, long long want) {
  long long v = -1; if (!json_int(line, key, &v) || v != want) g_selftest_errors++;
}
static void expect_str(const char *line, const char *key, const char *want) {
  char v[64] = {0}; if (!json_str(line, key, v, sizeof v) || strcmp(v, want)) g_selftest_errors++;
}
static int self_test(void) {
  const char *att = "{\"id\":7,\"cmd\":\"attach\",\"hwnd\":\"0x1A2B3C\",\"rect\":{\"x\":-1920,\"y\":0,\"w\":2560,\"h\":1440}}";
  char b[512]; HWND progman, defview_top = NULL, ww;
  expect_int(att, "id", 7); expect_int(att, "x", -1920); expect_int(att, "y", 0); expect_int(att, "w", 2560); expect_int(att, "h", 1440);
  expect_str(att, "cmd", "attach"); expect_str(att, "hwnd", "0x1A2B3C");
  if (_strtoui64("0x1A2B3C", NULL, 16) != 0x1A2B3C) g_selftest_errors++;
  { char v[4]; if (json_str("{\"cmd\":\"waytoolongforthebuffer\"}", "cmd", v, sizeof v)) g_selftest_errors++; } /* overflow refused */
  /* the request handler itself: these must answer with an error, never touch a window */
  handle("{\"id\":101}");                                              /* → bad-request */
  handle("{\"id\":102,\"cmd\":\"status\"}");                          /* → bad-hwnd */
  handle("{\"id\":103,\"cmd\":\"status\",\"hwnd\":\"0x0\"}");          /* → bad-hwnd (not a window) */
  handle("{\"id\":104,\"cmd\":\"explode\",\"hwnd\":\"0x0\"}");         /* → bad-hwnd before the command */
  progman = FindWindowW(L"Progman", NULL);
  EnumWindows(find_defview, (LPARAM)&defview_top);
  ww = progman ? FindWindowExW(progman, NULL, L"WorkerW", NULL) : NULL;
  snprintf(b, sizeof b,
    "{\"selfTest\":true,\"version\":\"%s\",\"ptrBits\":%d,\"osBuild\":%lu,\"parser\":%s,\"parserErrors\":%d,"
    "\"progman\":%s,\"legacyWorkerW\":%s,\"progmanChildWorkerW\":%s,\"taskbarCreatedMsg\":%s}",
    HELPER_VERSION, (int)(sizeof(void *) * 8), (unsigned long)build_number(), g_selftest_errors ? "false" : "true", g_selftest_errors,
    progman ? "true" : "false", defview_top ? "true" : "false", ww ? "true" : "false", RegisterWindowMessageW(L"TaskbarCreated") ? "true" : "false");
  emit(b);
  return g_selftest_errors ? 1 : 0;
}

int main(int argc, char **argv) {
  WNDCLASSW wc = {0}; HWND msg; MSG m;
  InitializeCriticalSection(&g_out);
  if (argc > 1 && !strcmp(argv[1], "--version")) { emit("{\"version\":\"" HELPER_VERSION "\",\"arch\":\"x64\"}"); return 0; }
  if (argc > 1 && !strcmp(argv[1], "--self-test")) return self_test();
  if (argc > 1) { fprintf(stderr, "usage: pixelpet-desktop-helper [--version | --self-test]\n"); return 2; }
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  g_taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
  wc.lpfnWndProc = wndproc; wc.hInstance = GetModuleHandleW(NULL); wc.lpszClassName = L"PixelPetDesktopHelper";
  RegisterClassW(&wc);
  /* a hidden top-level window (not message-only: TaskbarCreated is broadcast to top-level windows) */
  msg = CreateWindowExW(WS_EX_TOOLWINDOW, wc.lpszClassName, L"", WS_POPUP, 0, 0, 0, 0, NULL, NULL, wc.hInstance, NULL);
  WTSRegisterSessionNotification(msg, NOTIFY_FOR_THIS_SESSION);
  SetTimer(msg, 1, 2000, NULL);
  CreateThread(NULL, 0, reader, NULL, 0, NULL);
  while (GetMessageW(&m, NULL, 0, 0) > 0) { TranslateMessage(&m); DispatchMessageW(&m); }
  return 0;
}
