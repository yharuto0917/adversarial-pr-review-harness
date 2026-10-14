import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// next dev から Cloudflare のバインディングを触れるようにする
initOpenNextCloudflareForDev();
