import {
  createReleaseChangelogWriterOpts,
  RELEASE_CHANGELOG_PARSER_OPTS,
  RELEASE_CHANGELOG_TYPES,
} from "./scripts/release-it/changelog-writer.mjs";

export default {
  git: {
    commitMessage: "chore: 发布 v${version}",
    tagName: "v${version}",
    tagAnnotation: "发布 v${version}",
    push: false,
    pushRepo: "origin",
  },
  github: {
    release: false,
  },
  gitlab: {
    release: false,
  },
  npm: {
    publish: false,
  },
  plugins: {
    "@release-it/conventional-changelog": {
      preset: {
        name: "conventionalcommits",
        types: RELEASE_CHANGELOG_TYPES,
      },
      parserOpts: RELEASE_CHANGELOG_PARSER_OPTS,
      writerOpts: createReleaseChangelogWriterOpts(),
      infile: "CHANGELOG.md",
    },
  },
};
