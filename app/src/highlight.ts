import { refractor } from "refractor";
import typescript from "refractor/typescript";
import tsx from "refractor/tsx";
import javascript from "refractor/javascript";
import jsx from "refractor/jsx";
import json from "refractor/json";
import css from "refractor/css";
import scss from "refractor/scss";
import python from "refractor/python";
import rust from "refractor/rust";
import go from "refractor/go";
import java from "refractor/java";
import ruby from "refractor/ruby";
import bash from "refractor/bash";
import yaml from "refractor/yaml";
import markdown from "refractor/markdown";
import sql from "refractor/sql";
import graphql from "refractor/graphql";
import markup from "refractor/markup";

[
  typescript, tsx, javascript, jsx, json, css, scss, python, rust, go,
  java, ruby, bash, yaml, markdown, sql, graphql, markup,
].forEach((lang) => refractor.register(lang));

// react-diff-view v3 was built against refractor v3, where `.highlight()`
// returned the children array directly. Refractor v5 returns a Root node
// `{ type: 'root', children: [...] }`. Adapt by unwrapping `.children`.
export const refractorAdapter = {
  highlight(value: string, language: string) {
    const tree = refractor.highlight(value, language);
    return (tree as any).children ?? [];
  },
};

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  scss: "scss",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
};

export function languageForPath(filePath: string): string | null {
  const idx = filePath.lastIndexOf(".");
  if (idx < 0) return null;
  const ext = filePath.slice(idx + 1).toLowerCase();
  return EXT_LANG[ext] ?? null;
}
