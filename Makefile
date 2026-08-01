.PHONY: all typecheck test test-typescript test-ruby test-installer test-release build

all: typecheck test build

typecheck:
	npm run typecheck

test: test-typescript test-ruby test-installer test-release

test-typescript:
	npm test

test-ruby:
	ruby test/setup_epic_test.rb

test-installer:
	bash test/install.test.sh

test-release:
	bash test/release.test.sh

build:
	npm run build
