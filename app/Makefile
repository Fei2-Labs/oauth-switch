APP_NAME = OAuthSwitch
BUNDLE = $(APP_NAME).app
BUILD_DIR = .build/release
INSTALL_DIR = /Applications
VERSION_FILE = OAuthSwitch/Generated/AppVersion.swift

.PHONY: build install clean run version

# Regenerate the build-time version file. A committed fallback (version "dev")
# keeps plain `swift build` working; this target overwrites it with real values.
version:
	@mkdir -p "OAuthSwitch/Generated"
	@PKG_VERSION="$$(node -p 'require("../package.json").version' 2>/dev/null || echo dev)"; \
	GIT_HASH="$$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"; \
	if ! git diff --quiet -- ':(exclude,top)app/OAuthSwitch/Generated/AppVersion.swift' 2>/dev/null \
	   || ! git diff --cached --quiet -- ':(exclude,top)app/OAuthSwitch/Generated/AppVersion.swift' 2>/dev/null; then \
	  GIT_HASH="$$GIT_HASH-dirty"; \
	fi; \
	BUILD_DATE="$$(date '+%Y-%m-%d %H:%M')"; \
	printf '%s\n' \
	  '// Generated at build time by `make version` (see app/Makefile).' \
	  '// This committed fallback keeps a plain `swift build` working; make overwrites' \
	  '// it with the real version, git hash, and build date. Do not edit by hand.' \
	  'enum AppVersion {' \
	  "    static let version = \"$$PKG_VERSION\"" \
	  "    static let gitHash = \"$$GIT_HASH\"" \
	  "    static let buildDate = \"$$BUILD_DATE\"" \
	  '    static var display: String { "v\(version) (\(gitHash)) \(buildDate)" }' \
	  '}' > "$(VERSION_FILE)"
	@echo "Generated $(VERSION_FILE)"

build: version
	swift build -c release

install: build
	rm -rf $(INSTALL_DIR)/$(BUNDLE)
	mkdir -p $(INSTALL_DIR)/$(BUNDLE)/Contents/MacOS
	mkdir -p $(INSTALL_DIR)/$(BUNDLE)/Contents/Resources
	cp $(BUILD_DIR)/$(APP_NAME) $(INSTALL_DIR)/$(BUNDLE)/Contents/MacOS/
	cp Info.plist $(INSTALL_DIR)/$(BUNDLE)/Contents/
	@PKG_VERSION="$$(node -p 'require("../package.json").version' 2>/dev/null || echo dev)"; \
	/usr/libexec/PlistBuddy \
	  -c "Set :CFBundleShortVersionString $$PKG_VERSION" \
	  -c "Set :CFBundleVersion $$PKG_VERSION" \
	  "$(INSTALL_DIR)/$(BUNDLE)/Contents/Info.plist" || true
	cp OAuthSwitch/Resources/AppIcon.icns $(INSTALL_DIR)/$(BUNDLE)/Contents/Resources/
	cp -R $(BUILD_DIR)/$(APP_NAME)_$(APP_NAME).bundle $(INSTALL_DIR)/$(BUNDLE)/Contents/Resources/
	xattr -cr $(INSTALL_DIR)/$(BUNDLE)
	codesign --force --deep --sign - $(INSTALL_DIR)/$(BUNDLE)
	@echo "Installed to $(INSTALL_DIR)/$(BUNDLE)"

run: build
	$(BUILD_DIR)/$(APP_NAME)

clean:
	swift package clean
	rm -rf .build
