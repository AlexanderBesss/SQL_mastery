import type { NextConfig } from 'next';

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
const owner = process.env.GITHUB_REPOSITORY_OWNER;
const isUserSite = Boolean(repository && owner && repository.toLowerCase() === `${owner.toLowerCase()}.github.io`);
const pagesBasePath = process.env.GITHUB_ACTIONS === 'true' && repository && !isUserSite ? `/${repository}` : '';

const nextConfig: NextConfig = process.env.GITHUB_ACTIONS === 'true'
  ? { output: 'export', trailingSlash: true, basePath: pagesBasePath, assetPrefix: pagesBasePath, images: { unoptimized: true } }
  : {};

export default nextConfig;
