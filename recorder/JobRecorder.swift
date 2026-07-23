// JobRecorder — minimal ScreenCaptureKit CLI recorder for JobManager.
//
// Usage: JobRecorder <output.mov>
// Records the main display + system audio + default microphone until it
// receives SIGINT/SIGTERM, then finalizes the .mov and exits 0.
//
// Build: npm run build:recorder   (swiftc -O -o bin/JobRecorder recorder/JobRecorder.swift)
// Requires macOS 15+ (SCRecordingOutput + microphone capture).

import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit

guard CommandLine.arguments.count == 2 else {
    fputs("usage: JobRecorder <output.mov>\n", stderr)
    exit(2)
}
let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])

@available(macOS 15.0, *)
final class Recorder: NSObject, SCStreamDelegate, SCRecordingOutputDelegate {
    private var stream: SCStream?

    func start(outputURL: URL) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw NSError(domain: "JobRecorder", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no display found"])
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        config.width = Int(filter.contentRect.width * scale)
        config.height = Int(filter.contentRect.height * scale)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.showsCursor = true
        config.capturesAudio = true          // system audio (the interviewer)
        config.sampleRate = 48_000
        config.channelCount = 2
        config.captureMicrophone = true      // default mic (you)

        let stream = SCStream(filter: filter, configuration: config, delegate: self)

        let recConfig = SCRecordingOutputConfiguration()
        recConfig.outputURL = outputURL
        recConfig.outputFileType = .mov
        let recordingOutput = SCRecordingOutput(configuration: recConfig, delegate: self)
        try stream.addRecordingOutput(recordingOutput)

        try await stream.startCapture()
        self.stream = stream
    }

    /// Stopping the stream finalizes the recording output file.
    func stop() async {
        if let stream { try? await stream.stopCapture() }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("stream stopped unexpectedly: \(error.localizedDescription)\n", stderr)
        exit(1)
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        fputs("recording failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

// ScreenCaptureKit shows a menu-bar "recording" indicator, which requires a real
// AppKit main loop — a bare dispatchMain() CLI crashes when SCK creates that UI.
// So we run as an invisible (accessory) AppKit app.
@available(macOS 15.0, *)
final class AppDelegate: NSObject, NSApplicationDelegate {
    let recorder = Recorder()
    let outputURL: URL
    var stopping = false
    var signalSources: [DispatchSourceSignal] = []

    init(outputURL: URL) {
        self.outputURL = outputURL
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                guard let self, !self.stopping else { return }
                self.stopping = true
                Task {
                    await self.recorder.stop()
                    fputs("recording finalized\n", stderr)
                    exit(0)
                }
            }
            source.resume()
            signalSources.append(source)
        }

        Task {
            do {
                try await recorder.start(outputURL: outputURL)
                fputs("recording to \(outputURL.path)\n", stderr)
            } catch {
                fputs("failed to start: \(error.localizedDescription)\n", stderr)
                exit(1)
            }
        }
    }
}

if #available(macOS 15.0, *) {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory) // no Dock icon
    let delegate = AppDelegate(outputURL: outputURL)
    app.delegate = delegate
    app.run()
} else {
    fputs("JobRecorder requires macOS 15 or newer\n", stderr)
    exit(2)
}
