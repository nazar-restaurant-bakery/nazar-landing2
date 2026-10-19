import type { Plugin } from "vite";

type BuildContext = {
  command: "build" | "serve";
  mode: string;
  env: Record<string, string | undefined>;
};

// Cloudflare Production for this repository follows main. Do not use
// CF_PAGES_URL: a Production deployment can also have a hash-based URL.
export function suppressProductionAnalytics({ command, mode, env }: BuildContext): boolean {
  return command === "serve" || mode !== "production"
    || Boolean(env.CF_PAGES_BRANCH && env.CF_PAGES_BRANCH !== "main")
    || Boolean(env.APP_ENV && env.APP_ENV !== "production")
    || Boolean(env.VITE_APP_ENV && env.VITE_APP_ENV !== "production")
    || Object.keys(env).some((name) => name.startsWith("TEST_") || name.startsWith("VITE_TEST_"));
}

export function productionAnalyticsHtml(context: BuildContext): Plugin {
  const suppress = suppressProductionAnalytics(context);
  return {
    name: "isolated-production-analytics-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        // Keep the parser-time static async tag and inline initializer exactly
        // as before in Production; no replacement runtime loader is emitted.
        if (!suppress) return html;
        const block = /[ \t]*<!-- Google tag \(gtag\.js\)[^\r\n]*-->\r?\n[ \t]*<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-LK46HFY46G"><\/script>\r?\n[ \t]*<script>[\s\S]*?<\/script>\r?\n/;
        if (!block.test(html)) throw new Error("Expected Production analytics block is missing; refusing an isolated build");
        return html.replace(block, "");
      },
    },
  };
}
