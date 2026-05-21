APP_NAME = OAuthSwitch
BUNDLE = $(APP_NAME).app
BUILD_DIR = .build/release
INSTALL_DIR = /Applications

.PHONY: build install clean run

build:
	swift build -c release

install: build
	rm -rf $(INSTALL_DIR)/$(BUNDLE)
	mkdir -p $(INSTALL_DIR)/$(BUNDLE)/Contents/MacOS
	mkdir -p $(INSTALL_DIR)/$(BUNDLE)/Contents/Resources
	cp $(BUILD_DIR)/$(APP_NAME) $(INSTALL_DIR)/$(BUNDLE)/Contents/MacOS/
	cp Info.plist $(INSTALL_DIR)/$(BUNDLE)/Contents/
	cp OAuthSwitch/Resources/AppIcon.icns $(INSTALL_DIR)/$(BUNDLE)/Contents/Resources/
	@echo "Installed to $(INSTALL_DIR)/$(BUNDLE)"

run: build
	$(BUILD_DIR)/$(APP_NAME)

clean:
	swift package clean
	rm -rf .build
