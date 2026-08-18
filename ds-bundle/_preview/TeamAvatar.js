"use strict";
var __dsPreview = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e) {
      throw err = [e], e;
    }
  };
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, "default"), secondTarget && __copyProps(secondTarget, mod, "default"));
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // <define:import.meta.env>
  var init_define_import_meta_env = __esm({
    "<define:import.meta.env>"() {
    }
  });

  // ds-raw:__ds_raw__
  var require_ds_raw = __commonJS({
    "ds-raw:__ds_raw__"(exports, module) {
      init_define_import_meta_env();
      module.exports = window.LacesOut;
    }
  });

  // shim:react-shim
  var require_react_shim = __commonJS({
    "shim:react-shim"(exports, module) {
      init_define_import_meta_env();
      var R = window.React;
      function np(p, k) {
        var o = {};
        for (var x in p) if (x !== "children") o[x] = p[x];
        if (k !== void 0) o.key = k;
        return o;
      }
      function jsx2(t, p, k) {
        var c = p && p.children;
        return c === void 0 ? R.createElement(t, np(p, k)) : R.createElement(t, np(p, k), c);
      }
      function jsxs2(t, p, k) {
        return R.createElement.apply(R, [t, np(p, k)].concat(p.children));
      }
      module.exports = R;
      module.exports.jsx = jsx2;
      module.exports.jsxs = jsxs2;
      module.exports.jsxDEV = function(t, p, k, s) {
        return (s ? jsxs2 : jsx2)(t, p, k);
      };
      module.exports.Fragment = R.Fragment;
    }
  });

  // .design-sync/previews/TeamAvatar.tsx
  var TeamAvatar_exports = {};
  __export(TeamAvatar_exports, {
    CurrentTeamHighlight: () => CurrentTeamHighlight,
    InitialsAndAbbreviations: () => InitialsAndAbbreviations,
    SizeScale: () => SizeScale,
    StandingsList: () => StandingsList
  });
  init_define_import_meta_env();

  // ds-shim:ds
  var ds_exports = {};
  __export(ds_exports, {
    default: () => ds_default
  });
  init_define_import_meta_env();
  __reExport(ds_exports, __toESM(require_ds_raw()));
  var g = window.LacesOut;
  var ds_default = "default" in g ? g.default : g;

  // .design-sync/previews/TeamAvatar.tsx
  var import_jsx_runtime = __toESM(require_react_shim(), 1);
  function Caption({ children }) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "span",
      {
        style: {
          fontFamily: "var(--font-sans)",
          fontSize: "11px",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--ink-500)"
        },
        children
      }
    );
  }
  function SizeScale() {
    const sizes = [
      { size: "small", label: "Small · 22px", where: "Draft ticker, activity feed" },
      { size: "medium", label: "Medium · 30px", where: "Standings, matchup rows" },
      { size: "large", label: "Large · 44px", where: "Team header, trade block" }
    ];
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "flex-start",
          gap: "34px",
          padding: "20px 22px",
          background: "var(--paper-100)",
          border: "1px solid var(--ink-150)",
          borderRadius: "12px",
          fontFamily: "var(--font-sans)"
        },
        children: sizes.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "div",
          {
            style: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "9px" },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", height: "44px", alignItems: "center" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ds_exports.TeamAvatar, { teamName: "Bijan Mustard", size: entry.size }) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Caption, { children: entry.label }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: "12px", color: "var(--ink-700)" }, children: entry.where })
            ]
          },
          entry.size
        ))
      }
    );
  }
  function CurrentTeamHighlight() {
    const teams = [
      { name: "Kupp of Joe", mine: false },
      { name: "Bijan Mustard", mine: false },
      { name: "Puka Your Eyes Out", mine: true },
      { name: "Nabers Watch", mine: false }
    ];
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          padding: "20px 22px",
          background: "var(--paper-100)",
          border: "1px solid var(--ink-150)",
          borderRadius: "12px",
          fontFamily: "var(--font-sans)"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Caption, { children: "Week 11 · your team is ringed" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", alignItems: "center", gap: "18px" }, children: teams.map((team) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "div",
            {
              style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "7px", width: "88px" },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ds_exports.TeamAvatar, { teamName: team.name, size: "large", highlight: team.mine }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "span",
                  {
                    style: {
                      fontSize: "11px",
                      lineHeight: 1.3,
                      textAlign: "center",
                      color: team.mine ? "var(--ink-900)" : "var(--ink-500)",
                      fontWeight: team.mine ? 700 : 500
                    },
                    children: team.name
                  }
                )
              ]
            },
            team.name
          )) })
        ]
      }
    );
  }
  function InitialsAndAbbreviations() {
    const rows = [
      { name: "Kupp of Joe", abbr: null, note: "two words → K O" },
      { name: "Ja'Marr the Merrier", abbr: null, note: "punctuation stripped → J T" },
      { name: "Jefferson", abbr: null, note: "one word → first 2 letters" },
      { name: "Kupp of Joe", abbr: "KOJ", note: "abbreviation wins → first 3 chars" },
      { name: "Ja'Marr the Merrier", abbr: "CIN", note: "provider abbreviation" }
    ];
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          padding: "20px 22px",
          background: "var(--paper-100)",
          border: "1px solid var(--ink-150)",
          borderRadius: "12px",
          fontFamily: "var(--font-sans)",
          minWidth: "360px"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Caption, { children: "Derived initials vs. abbreviation" }),
          rows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: "12px" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ds_exports.TeamAvatar, { teamName: row.name, abbreviation: row.abbr, size: "medium" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--ink-900)", minWidth: "160px" }, children: row.name }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: "12px", color: "var(--ink-500)" }, children: row.note })
          ] }, `${row.name}-${row.abbr ?? "derived"}`))
        ]
      }
    );
  }
  function StandingsList() {
    const standings = [
      { rank: 1, name: "Bijan Mustard", record: "8-2", points: "1,342.6", mine: false },
      { rank: 2, name: "Puka Your Eyes Out", record: "7-3", points: "1,318.4", mine: true },
      { rank: 3, name: "Kupp of Joe", abbr: "KOJ", record: "7-3", points: "1,290.1", mine: false },
      { rank: 4, name: "Nabers Watch", record: "6-4", points: "1,264.9", mine: false },
      { rank: 5, name: "Ja'Marr the Merrier", record: "5-5", points: "1,201.7", mine: false }
    ];
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        style: {
          width: "420px",
          padding: "18px 20px 8px",
          background: "var(--paper-100)",
          border: "1px solid var(--ink-150)",
          borderRadius: "12px",
          fontFamily: "var(--font-sans)"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginBottom: "12px" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "div",
              {
                style: {
                  fontFamily: "var(--font-brand), var(--font-sans)",
                  fontSize: "16px",
                  fontWeight: 650,
                  letterSpacing: "-0.01em",
                  color: "var(--ink-900)"
                },
                children: "Bell Cow Bandits"
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Caption, { children: "Standings · through week 10" })
          ] }),
          standings.map((team) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "11px",
                padding: "9px 0",
                borderTop: "1px solid var(--ink-150)"
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { width: "16px", fontSize: "12px", color: "var(--ink-500)", fontVariantNumeric: "tabular-nums" }, children: team.rank }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ds_exports.TeamAvatar, { teamName: team.name, abbreviation: team.abbr, size: "medium", highlight: team.mine }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "span",
                  {
                    style: {
                      flex: 1,
                      fontSize: "13px",
                      fontWeight: team.mine ? 700 : 600,
                      color: "var(--ink-900)",
                      whiteSpace: "nowrap"
                    },
                    children: team.name
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--ink-700)", fontVariantNumeric: "tabular-nums" }, children: team.record }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "span",
                  {
                    style: {
                      width: "66px",
                      textAlign: "right",
                      fontSize: "13px",
                      color: "var(--ink-500)",
                      fontVariantNumeric: "tabular-nums"
                    },
                    children: team.points
                  }
                )
              ]
            },
            team.name
          ))
        ]
      }
    );
  }
  return __toCommonJS(TeamAvatar_exports);
})();
