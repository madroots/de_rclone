#!/bin/bash
# Script to build Tauri AppImage

set -e  # Exit on any error

echo "Building Tauri de_rclone AppImage..."

# Create build directory
mkdir -p build
cd build

echo "Installing tauri-cli if not already installed..."
cargo install tauri-cli --version 2.9.6

echo "Building the Tauri application..."
cd ../src-tauri
cargo tauri build
cd ../..

echo "Creating AppImage structure..."
mkdir -p build/AppDir/usr/bin
mkdir -p build/AppDir/usr/lib
mkdir -p build/AppDir/usr/share/applications
mkdir -p build/AppDir/usr/share/icons/hicolor/256x256/apps

echo "Copying application binary..."
cp ../src-tauri/target/release/rclone-manager build/AppDir/usr/bin/

echo "Creating AppRun script..."
cat > build/AppDir/AppRun << 'EOF'
#!/bin/bash
HERE="$(dirname "$(readlink -f "${0}")")"
export APPDIR="${HERE}"
export PATH="${HERE}/usr/bin:${HERE}/usr/lib:${PATH}"
export LD_LIBRARY_PATH="${HERE}/usr/lib:${LD_LIBRARY_PATH}"

# Run the application
exec "${HERE}/usr/bin/rclone-manager" "$@"
EOF

chmod +x build/AppDir/AppRun

echo "Creating desktop entry..."
cat > build/AppDir/rclone-manager.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=de_rclone
Comment=A CS16-style rclone GUI manager
Exec=rclone-manager
Icon=rclone-manager
Terminal=false
Categories=Utility;FileTools;
EOF

chmod 644 build/AppDir/rclone-manager.desktop

echo "Copying desktop entry to applications folder..."
cp build/AppDir/rclone-manager.desktop build/AppDir/usr/share/applications/

echo "Creating icon placeholder (to be replaced with actual icon)..."
# For now, just create a placeholder, but in a real scenario we'd copy an actual icon
echo "Icon placeholder" > build/AppDir/rclone-manager.png
cp build/AppDir/rclone-manager.png build/AppDir/usr/share/icons/hicolor/256x256/apps/rclone-manager.png

echo "Building AppImage using appimagetool..."

# Download appimagetool if not available
if ! command -v appimagetool &> /dev/null; then
    echo "Downloading appimagetool..."
    wget -O appimagetool "https://github.com/AppImage/appimagetool/releases/download/13/appimagetool-x86_64.AppImage"
    chmod +x appimagetool
fi

# Run appimagetool to create the AppImage
ARCH=x86_64 ./appimagetool --comp squashfs build/AppDir/

# Rename the resulting AppImage
if [ -f "de_rclone-*.AppImage" ]; then
    mv de_rclone-*.AppImage rclone-manager.AppImage
elif [ -f "rclone-manager-*.AppImage" ]; then
    mv rclone-manager-*.AppImage rclone-manager.AppImage
elif ls *.AppImage 1> /dev/null 2>&1; then
    mv *.AppImage rclone-manager.AppImage
fi

chmod +x rclone-manager.AppImage

echo "AppImage build complete!"
echo "AppImage is located at: $(pwd)/rclone-manager.AppImage"

# Create a symbolic link to the root directory for easy access
ln -sf rclone-manager.AppImage .. || true

echo "Build process finished successfully!"