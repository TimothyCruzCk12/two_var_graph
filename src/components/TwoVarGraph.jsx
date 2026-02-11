import React, { useState, useRef, useCallback, useEffect } from 'react';

const WIDTH = 500;
const HEIGHT = 500;
const MIN = -10;
const MAX = 10;
/** One full segment past MIN/MAX so arrows sit one unit beyond the last tick */
const EXTENDED_MIN = MIN - 1;
const EXTENDED_MAX = MAX + 1;
const PADDING = 40;
const centerX = WIDTH / 2;
const centerY = HEIGHT / 2;
const plotWidth = WIDTH - 2 * PADDING;
const plotHeight = HEIGHT - 2 * PADDING;
const scaleX = plotWidth / (MAX - MIN);
const scaleY = plotHeight / (MAX - MIN);

/** Map value x in [MIN, MAX] to SVG x */
const valueToX = (x) => centerX + x * scaleX;
/** Map value y in [MIN, MAX] to SVG y (SVG y increases downward) */
const valueToY = (y) => centerY - y * scaleY;
/** Map SVG x to value */
const xToValue = (px) => (px - centerX) / scaleX;
/** Map SVG y to value */
const yToValue = (py) => (centerY - py) / scaleY;

/** Clamp value to [MIN, MAX] */
const clamp = (v) => Math.max(MIN, Math.min(MAX, v));
/** Round value to nearest integer and clamp */
const roundToTick = (v) => Math.round(clamp(v));

const GRID_CELL = scaleX; // 1 unit
const EMPTY_CIRCLE_RADIUS = 8;
/** Max span (in px) to treat gesture as a point */
const POINT_MAX_SPAN = scaleX * 0.9;
const POINT_MIN_VERTICAL = 12;

/** Action types for undo/redo */
const ACTION_SEGMENT = 'segment';
const ACTION_EMPTY_CIRCLE = 'emptyCircle';

/** Generate path d string for a segment from start to end by shape type */
const getPathD = (shape, startPt, endPt) => {
	const x1 = startPt.x;
	const y1 = startPt.y;
	const x2 = endPt.x;
	const y2 = endPt.y;
	if (shape === 'line' || !shape) {
		return `M ${x1} ${y1} L ${x2} ${y2}`;
	}
	if (shape === 'exponential') {
		const k = 4;
		const denom = 1 - Math.exp(-k);
		const pts = [];
		for (let i = 0; i <= 20; i++) {
			const t = i / 20;
			const x = x1 + t * (x2 - x1);
			const yNorm = (1 - Math.exp(-k * t)) / denom;
			const y = y1 + yNorm * (y2 - y1);
			pts.push({ x, y });
		}
		return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
	}
	if (shape === 'parabola') {
		// Vertex at (x1,y1), one arm to (x2,y2); other arm mirrors across vertical through vertex
		const xv = x1, yv = y1;
		const xMirror = 2 * xv - x2;
		const cRight = (xv + x2) / 2;
		const cLeft = (3 * xv - x2) / 2;
		return `M ${xMirror} ${y2} Q ${cLeft} ${yv} ${xv} ${yv} Q ${cRight} ${yv} ${x2} ${y2}`;
	}
	return `M ${x1} ${y1} L ${x2} ${y2}`;
};

const reduceHistoryToState = (historySlice) => {
	let segs = [];
	let emptyPoints = [];
	for (const action of historySlice) {
		if (action.type === ACTION_SEGMENT) {
			// Support both { shape, points } and legacy [start, end]
			const data = action.data;
			const seg = Array.isArray(data)
				? { shape: 'line', points: data }
				: { shape: data.shape || 'line', points: data.points };
			segs = [...segs, seg];
		} else if (action.type === ACTION_EMPTY_CIRCLE) {
			const key = `${action.point.x},${action.point.y}`;
			if (!emptyPoints.some((p) => `${p.x},${p.y}` === key)) {
				emptyPoints = [...emptyPoints, action.point];
			}
		}
	}
	return { segments: segs, emptyCirclePoints: emptyPoints };
};

const tickValues = Array.from({ length: MAX - MIN + 1 }, (_, i) => MIN + i);

/** Exponential icon path: sampled from y ∝ 1 - e^(-kt) so it's flat then steep */
const EXP_ICON_PATH = (() => {
	const k = 3;
	const denom = 1 - Math.exp(-k);
	const pts = [];
	for (let i = 0; i <= 20; i++) {
		const t = i / 20;
		const x = 2 + (16 * t);
		const yNorm = (1 - Math.exp(-k * t)) / denom;
		const y = 2 + 16 * yNorm;
		pts.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`);
	}
	return pts.join(' ');
})();

const TwoVarGraph = () => {
	const [path, setPath] = useState([]);
	const [history, setHistory] = useState([]);
	const [historyIndex, setHistoryIndex] = useState(0);
	const { segments, emptyCirclePoints } = reduceHistoryToState(
		history.slice(0, historyIndex)
	);
	const [isDrawing, setIsDrawing] = useState(false);
	const [selectedShape, setSelectedShape] = useState('line'); // 'line' | 'exponential' | 'parabola'
	const containerRef = useRef(null);
	const isDrawingRef = useRef(false);
	isDrawingRef.current = isDrawing;
	const historyIndexRef = useRef(0);
	historyIndexRef.current = historyIndex;

	const pushHistory = useCallback((action) => {
		const idx = historyIndexRef.current;
		setHistory((h) => [...h.slice(0, idx), action]);
		setHistoryIndex(idx + 1);
	}, []);

	const clientToSvg = useCallback((clientX, clientY) => {
		const el = containerRef.current;
		if (!el) return null;
		const rect = el.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		return {
			x: Math.max(0, Math.min(WIDTH, x)),
			y: Math.max(0, Math.min(HEIGHT, y)),
		};
	}, []);

	const startDrawing = useCallback(
		(clientX, clientY) => {
			const pt = clientToSvg(clientX, clientY);
			if (pt) {
				setIsDrawing(true);
				setPath([pt]);
			}
		},
		[clientToSvg]
	);

	const moveDrawing = useCallback(
		(clientX, clientY) => {
			if (!isDrawing) return;
			const pt = clientToSvg(clientX, clientY);
			if (pt) {
				setPath((prev) => {
					if (prev.length === 0) return prev;
					const last = prev[prev.length - 1];
					if (last && last.x === pt.x && last.y === pt.y) return prev;
					// Anchor at first point; only the end follows the pointer
					return [prev[0], pt];
				});
			}
		},
		[isDrawing, clientToSvg]
	);

	const endDrawing = useCallback(() => {
		setIsDrawing(false);
		setPath((prev) => {
			if (prev.length < 2) return prev;
			const minX = Math.min(prev[0].x, prev[1].x);
			const maxX = Math.max(prev[0].x, prev[1].x);
			const minY = Math.min(prev[0].y, prev[1].y);
			const maxY = Math.max(prev[0].y, prev[1].y);
			const spanX = maxX - minX;
			const spanY = maxY - minY;
			const segmentLength = Math.hypot(prev[1].x - prev[0].x, prev[1].y - prev[0].y);

			// Short drag with vertical motion → empty circle at snapped center
			if (
				segmentLength < POINT_MAX_SPAN &&
				spanY >= POINT_MIN_VERTICAL
			) {
				const cx = (prev[0].x + prev[1].x) / 2;
				const cy = (prev[0].y + prev[1].y) / 2;
				const vx = roundToTick(xToValue(cx));
				const vy = roundToTick(yToValue(cy));
				pushHistory({ type: ACTION_EMPTY_CIRCLE, point: { x: vx, y: vy } });
				return [];
			}

			// Segment: snap anchor and release point to grid
			const startValX = xToValue(prev[0].x);
			const startValY = yToValue(prev[0].y);
			const endValX = xToValue(prev[1].x);
			const endValY = yToValue(prev[1].y);
			const x1 = roundToTick(startValX);
			const y1 = roundToTick(startValY);
			const x2 = roundToTick(endValX);
			const y2 = roundToTick(endValY);
			const startPt = { x: valueToX(x1), y: valueToY(y1) };
			const endPt = { x: valueToX(x2), y: valueToY(y2) };
			if (startPt.x === endPt.x && startPt.y === endPt.y) return [startPt];
			const shape = selectedShape || 'line';
			pushHistory({ type: ACTION_SEGMENT, data: { shape, points: [startPt, endPt] } });
			return [];
		});
	}, [pushHistory, selectedShape]);

	const handlePointerDown = useCallback(
		(e) => {
			e.preventDefault();
			startDrawing(e.clientX, e.clientY);
		},
		[startDrawing]
	);

	const handlePointerMove = useCallback(
		(e) => {
			moveDrawing(e.clientX, e.clientY);
		},
		[moveDrawing]
	);

	const handlePointerUp = useCallback(() => {
		endDrawing();
	}, [endDrawing]);

	const handleTouchStart = useCallback(
		(e) => {
			if (e.touches.length === 1) {
				startDrawing(e.touches[0].clientX, e.touches[0].clientY);
			}
		},
		[startDrawing]
	);

	const handleTouchMove = useCallback(
		(e) => {
			if (e.touches.length === 1) {
				moveDrawing(e.touches[0].clientX, e.touches[0].clientY);
			}
		},
		[moveDrawing]
	);

	const handleTouchEnd = useCallback(() => {
		endDrawing();
	}, [endDrawing]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onTouchMove = (e) => {
			if (isDrawingRef.current && e.touches.length === 1) e.preventDefault();
		};
		el.addEventListener('touchmove', onTouchMove, { passive: false });
		return () => el.removeEventListener('touchmove', onTouchMove);
	}, []);

	const pathD =
		path.length < 2
			? ''
			: getPathD(selectedShape || 'line', path[0], path[1]);
	const segmentPathD = (seg) => {
		const pts = seg.points || seg;
		if (pts.length < 2) return '';
		const shape = seg.shape != null ? seg.shape : 'line';
		return getPathD(shape, pts[0], pts[1]);
	};

	const canUndo = historyIndex > 0;
	const canRedo = historyIndex < history.length;
	const canReset = history.length > 0;

	const buttonStyle = (enabled) => ({
		padding: '4px 8px',
		fontSize: 12,
		cursor: enabled ? 'pointer' : 'default',
		opacity: enabled ? 1 : 0.5,
	});

	// Axis line endpoints: extend one segment past MIN/MAX (arrows at extended ends)
	const arrowSize = 8;
	const xMin = valueToX(EXTENDED_MIN);
	const xMax = valueToX(EXTENDED_MAX);
	const yMin = valueToY(EXTENDED_MIN);
	const yMax = valueToY(EXTENDED_MAX);
	const xAxisLeft = xMin + arrowSize;
	const xAxisRight = xMax - arrowSize;
	const yAxisTop = yMax + arrowSize;
	const yAxisBottom = yMin - arrowSize;

	return (
		<div
			ref={containerRef}
			className="two-var-graph"
			style={{
				position: 'relative',
				width: WIDTH,
				height: HEIGHT,
				border: '1px solid #ccc',
				borderRadius: 4,
				overflow: 'hidden',
				backgroundColor: '#fafafa',
				touchAction: 'none',
			}}
			onMouseDown={handlePointerDown}
			onMouseMove={handlePointerMove}
			onMouseUp={handlePointerUp}
			onMouseLeave={handlePointerUp}
			onTouchStart={handleTouchStart}
			onTouchMove={handleTouchMove}
			onTouchEnd={handleTouchEnd}
			onTouchCancel={handleTouchEnd}
		>
			{/* Top-left: shape icon buttons */}
			<div
				style={{
					position: 'absolute',
					top: 11,
					left: 12,
					display: 'flex',
					gap: 6,
					alignItems: 'center',
					zIndex: 1,
				}}
			>
				<button
					type="button"
					title="Line"
					onClick={() => setSelectedShape((s) => (s === 'line' ? null : 'line'))}
					style={{
						width: 32,
						height: 32,
						padding: 0,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						border: '1px solid #ccc',
						borderRadius: 4,
						backgroundColor: '#fff',
						cursor: 'pointer',
						outline: selectedShape === 'line' ? '2px solid #1967d2' : 'none',
						outlineOffset: 1,
					}}
				>
					<svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round">
						<line x1={2} y1={18} x2={18} y2={2} />
					</svg>
				</button>
				<button
					type="button"
					title="Exponential"
					onClick={() => setSelectedShape((s) => (s === 'exponential' ? null : 'exponential'))}
					style={{
						width: 32,
						height: 32,
						padding: 0,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						border: '1px solid #ccc',
						borderRadius: 4,
						backgroundColor: '#fff',
						cursor: 'pointer',
						outline: selectedShape === 'exponential' ? '2px solid #1967d2' : 'none',
						outlineOffset: 1,
					}}
				>
					<svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
						<path d={EXP_ICON_PATH} />
					</svg>
				</button>
				<button
					type="button"
					title="Parabola"
					onClick={() => setSelectedShape((s) => (s === 'parabola' ? null : 'parabola'))}
					style={{
						width: 32,
						height: 32,
						padding: 0,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						border: '1px solid #ccc',
						borderRadius: 4,
						backgroundColor: '#fff',
						cursor: 'pointer',
						outline: selectedShape === 'parabola' ? '2px solid #1967d2' : 'none',
						outlineOffset: 1,
					}}
				>
					<svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
						<path d="M 2 18 Q 10 -14 18 18" />
					</svg>
				</button>
			</div>
			<div
				style={{
					position: 'absolute',
					top: 11,
					right: 12,
					display: 'flex',
					gap: 6,
					alignItems: 'center',
					zIndex: 1,
				}}
			>
				<button
					type="button"
					onClick={() => setHistoryIndex((i) => Math.max(0, i - 1))}
					disabled={!canUndo}
					style={buttonStyle(canUndo)}
				>
					Undo
				</button>
				<button
					type="button"
					onClick={() => setHistoryIndex((i) => Math.min(history.length, i + 1))}
					disabled={!canRedo}
					style={buttonStyle(canRedo)}
				>
					Redo
				</button>
				<button
					type="button"
					onClick={() => {
						setHistory([]);
						setHistoryIndex(0);
					}}
					disabled={!canReset}
					style={{
						...buttonStyle(canReset),
						backgroundColor: '#e34242',
						borderRadius: 6,
						border: 'none',
					}}
				>
					Reset
				</button>
			</div>
			<svg width={WIDTH} height={HEIGHT} style={{ display: 'block' }}>
				<defs>
					<pattern
						id="grid-two"
						x={PADDING}
						y={PADDING}
						width={GRID_CELL}
						height={GRID_CELL}
						patternUnits="userSpaceOnUse"
					>
						<path
							d={`M 0 0 L 0 ${GRID_CELL} M 0 0 L ${GRID_CELL} 0 M ${GRID_CELL} 0 L ${GRID_CELL} ${GRID_CELL} M 0 ${GRID_CELL} L ${GRID_CELL} ${GRID_CELL}`}
							stroke="#e0e0e0"
							strokeWidth="0.5"
							fill="none"
						/>
					</pattern>
				</defs>
				<rect width={WIDTH} height={HEIGHT} fill="url(#grid-two)" />
				{/* X axis */}
				<line
					x1={xAxisLeft}
					y1={centerY}
					x2={xAxisRight}
					y2={centerY}
					stroke="#333"
					strokeWidth={2}
				/>
				{/* Y axis */}
				<line
					x1={centerX}
					y1={yAxisTop}
					x2={centerX}
					y2={yAxisBottom}
					stroke="#333"
					strokeWidth={2}
				/>
				{/* X axis ticks and labels */}
				{tickValues.map((value) => {
					const x = valueToX(value);
					return (
						<g key={`x-${value}`}>
							<line
								x1={x}
								y1={centerY}
								x2={x}
								y2={centerY + 10}
								stroke="#333"
								strokeWidth={1.5}
							/>
							{value !== 0 && (
								<text
									x={x}
									y={centerY + 26}
									textAnchor="middle"
									fontSize={14}
									fill="#333"
									fontFamily="system-ui, sans-serif"
								>
									{value}
								</text>
							)}
						</g>
					);
				})}
				{/* Y axis ticks and labels */}
				{tickValues.map((value) => {
					const y = valueToY(value);
					return (
						<g key={`y-${value}`}>
							<line
								x1={centerX}
								y1={y}
								x2={centerX - 10}
								y2={y}
								stroke="#333"
								strokeWidth={1.5}
							/>
							{value !== 0 && (
								<text
									x={centerX - 14}
									y={y + 5}
									textAnchor="end"
									fontSize={14}
									fill="#333"
									fontFamily="system-ui, sans-serif"
								>
									{value}
								</text>
							)}
						</g>
					);
				})}
				{/* Arrows at all 4 ends: right (+x), left (-x), top (+y), bottom (-y) */}
				<polygon
					points={`${xMax - arrowSize},${centerY - arrowSize} ${xMax},${centerY} ${xMax - arrowSize},${centerY + arrowSize}`}
					fill="#333"
				/>
				<polygon
					points={`${xMin + arrowSize},${centerY - arrowSize} ${xMin},${centerY} ${xMin + arrowSize},${centerY + arrowSize}`}
					fill="#333"
				/>
				<polygon
					points={`${centerX - arrowSize},${yMax + arrowSize} ${centerX},${yMax} ${centerX + arrowSize},${yMax + arrowSize}`}
					fill="#333"
				/>
				<polygon
					points={`${centerX - arrowSize},${yMin - arrowSize} ${centerX},${yMin} ${centerX + arrowSize},${yMin - arrowSize}`}
					fill="#333"
				/>
				{/* Empty circles */}
				{emptyCirclePoints.map((p) => (
					<circle
						key={`empty-${p.x},${p.y}`}
						cx={valueToX(p.x)}
						cy={valueToY(p.y)}
						r={EMPTY_CIRCLE_RADIUS}
						fill="none"
						stroke="#1967d2"
						strokeWidth={2}
					/>
				))}
				{/* Line segments */}
				{segments.map((seg, idx) => (
					<path
						key={idx}
						d={segmentPathD(seg)}
						fill="none"
						stroke="#1967d2"
						strokeWidth={4}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				))}
				{/* Current stroke */}
				{path.length >= 2 && (
					<path
						d={pathD}
						fill="none"
						stroke="#1967d2"
						strokeWidth={4}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				)}
			</svg>
		</div>
	);
};

export default TwoVarGraph;
