import PinomadChat
import SwiftUI
import UniformTypeIdentifiers

extension View {
    /// The multi-file picker behind "Attach files…". The model reads each
    /// URL under its security scope and copies the bytes before uploading.
    func fileAttachmentImporter(
        model: AppModel, key: UInt64, isPresented: Binding<Bool>
    ) -> some View {
        fileImporter(
            isPresented: isPresented,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case let .success(urls):
                model.attachFiles(conversation: key, urls: urls)
            case let .failure(error):
                model.reportFileProblem(
                    conversation: key,
                    "Couldn't attach files: \(error.localizedDescription)"
                )
            }
        }
    }
}
