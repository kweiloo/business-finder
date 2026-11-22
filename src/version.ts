// The version comes from package.json. Bundlers inline JSON imports, so the
// built CLI carries the version string without reading files at runtime.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/** Single source of truth for the GitHub repository slug while the repo rename is pending. */
export const REPO_SLUG = "kweiloo/business-finder";
export const REPO_URL = `https://github.com/${REPO_SLUG}`;
export const USER_AGENT = `business-finder/${VERSION} (+${REPO_URL})`;
