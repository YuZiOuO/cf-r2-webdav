import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				isolatedStorage: false,
				singleWorker: true,
				remoteBindings: false,
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						WEBDAV_USERNAME: "test-user",
						WEBDAV_PASSWORD: "test-password",
					},
				},
			},
		},
	},
});
