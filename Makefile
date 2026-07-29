.PHONY: all typecheck test test-typescript test-ruby test-installer build

all: typecheck test build

typecheck:
	npm run typecheck

test: test-typescript test-ruby test-installer

test-typescript:
	npm test

test-ruby:
	ruby test/setup_epic_test.rb

test-installer:
	bash test/install.test.sh

build:
	npm run build
