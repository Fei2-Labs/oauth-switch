import SwiftUI
import AppKit

struct ProviderIconView: View {
    let provider: ProviderID
    var size: CGFloat = 16
    var cornerRadius: CGFloat = 4
    var tint: Color? = nil
    var scale: CGFloat = 1

    var body: some View {
        Group {
            if let icon = ProviderTemplateIconResolver.image(for: provider, pointSize: size * scale) {
                Image(nsImage: icon)
                    .renderingMode(.template)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(tint ?? .primary)
                    .frame(width: size * scale, height: size * scale)
                    .frame(width: size, height: size)
            } else {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color.white.opacity(0.14))
                    .overlay(
                        Text(String(provider.title.prefix(1)))
                            .font(.system(size: size * 0.56, weight: .bold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.9))
                    )
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(provider.title)
    }
}

enum ProviderTemplateIconResolver {
    private static var cache: [String: NSImage] = [:]

    static func image(for provider: ProviderID, pointSize: CGFloat? = nil) -> NSImage? {
        let cacheKey = "\(provider.rawValue)-\(pointSize.map { String(format: "%.2f", $0) } ?? "default")"
        if let cached = cache[cacheKey] {
            return cached
        }

        let bundle = Bundle.module
        let candidates = [
            bundle.url(forResource: provider.templateAssetName, withExtension: "png"),
            bundle.url(forResource: provider.templateAssetName, withExtension: "pdf"),
        ].compactMap { $0 }

        for url in candidates {
            if let image = NSImage(contentsOf: url) {
                let icon = image.copy() as? NSImage ?? image
                if let pointSize {
                    icon.size = NSSize(width: pointSize, height: pointSize)
                }
                icon.isTemplate = true
                cache[cacheKey] = icon
                return icon
            }
        }

        return nil
    }
}
