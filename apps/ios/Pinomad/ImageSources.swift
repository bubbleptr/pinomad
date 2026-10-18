import PhotosUI
import PinomadChat
import SwiftUI

extension View {
    /// The photo library and camera behind a composer's "+" menu, feeding
    /// images into the tray under `key` (a conversation id, or the draft).
    func imageSources(model: AppModel, key: UInt64, accepts: Bool,
                      showPhotos: Binding<Bool>, showCamera: Binding<Bool>) -> some View {
        modifier(ImageSources(model: model, key: key, accepts: accepts,
                              showPhotos: showPhotos, showCamera: showCamera))
    }
}

/// Present after a Menu has gone: presenting from inside a Menu action can
/// be dropped while the menu is still dismissing.
@MainActor
func presentAfterMenu(_ present: @escaping @MainActor () -> Void) {
    Task { @MainActor in
        try? await Task.sleep(for: .milliseconds(50))
        present()
    }
}

private struct ImageSources: ViewModifier {
    let model: AppModel
    let key: UInt64
    let accepts: Bool
    @Binding var showPhotos: Bool
    @Binding var showCamera: Bool
    @State private var photoItems: [PhotosPickerItem] = []

    private var freeSlots: Int { (model.trays[key] ?? AttachmentTray()).freeSlots }

    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: $showPhotos, selection: $photoItems,
                          maxSelectionCount: max(freeSlots, 1), matching: .images)
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                photoItems = []
                model.attach(conversation: key, accepts: accepts, sources: items.map { item in
                    { @Sendable in
                        guard let data = try await item.loadTransferable(type: Data.self) else {
                            throw ImagePrep.Failure(description: "无法读取图片")
                        }
                        return data
                    }
                })
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in
                    guard let data = image.jpegData(compressionQuality: 1) else { return }
                    model.attach(conversation: key, accepts: accepts, sources: [{ @Sendable in data }])
                }
                .ignoresSafeArea()
            }
    }
}
