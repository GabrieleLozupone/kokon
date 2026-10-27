import XCTest
@testable import KokonEngine

/// The bench's report: the summary row and where each image's time goes, from the children's JSON.
final class BenchReportTests: XCTestCase {
    func testReportHasEveryImagesParts() {
        let part: (Double) -> [String: Any] = { total in ["encode": 2.5, "load": 0.4, "step1": 9.1, "steps": 50.0, "vae": 4.3, "total": total] }
        let row: [String: Any] = ["name": "default (paths above)", "image1": 63.7, "image2": 72.1, "step": 7.15, "vae": 4.31, "peak": 8.5,
                                  "parts": [part(63.7), part(72.1)]]
        let report = Bench.report(chip: Chip.current, paths: [], reference: [:], rows: [row], quick: false)
        XCTAssertTrue(report.contains("| default (paths above) | 63.7 s | 72.1 s | 7.15 s | 4.31 s | 8.5 GB |"), report)
        XCTAssertTrue(report.contains("| default (paths above) | 1 | 2.50 | 0.40 | 9.10 | 50.0 | 4.30 | 63.7 |"), report)
        XCTAssertTrue(report.contains("| default (paths above) | 2 | 2.50 | 0.40 | 9.10 | 50.0 | 4.30 | 72.1 |"), report)
    }

    func testSummaryCarriesTheNumbers() throws {
        let row: [String: Any] = ["name": "default (paths above)", "image1": 63.7, "step": 7.15, "vae": 4.31, "peak": 8.5,
                                  "velocity": "/nonexistent-velocity.f32"]
        let summary = Bench.summary(chip: Chip.current, paths: [], reference: [:], rows: [row], quick: true)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(summary))
        let run = try XCTUnwrap((summary["runs"] as? [[String: Any]])?.first)
        XCTAssertEqual(run["image1"] as? Double, 63.7)
        XCTAssertNil(run["velocity"], "the children's file paths stay out")
        XCTAssertNil(run["velocityError"], "no reference, no error")
        XCTAssertEqual(summary["model"] as? String, Chip.current.model)
    }
}
