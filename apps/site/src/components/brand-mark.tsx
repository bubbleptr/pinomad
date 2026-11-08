/**
 * The ghost from the app icon (apps/web/public/favicon.svg) without its tile, drawn
 * inline so the page colours it: hat, eyes and outline in currentColor, the body in
 * --mark-body (white unless a stylesheet says otherwise). The viewBox is cropped to the
 * ghost, outline included.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="138 140 304 266" aria-hidden="true" focusable="false">
      <path
        className="mark-body"
        d="M 368 244 C 384 278 372 326 348 353 C 322 382 287 398 255 396 C 234 395 221 387 228 368 C 230 362 223 365 215 366 C 185 369 165 359 159 346 C 154 337 157 337 168 335 C 197 332 211 308 221 282 C 231 254 253 244 283 233 C 318 219 350 212 362 232 Z"
        strokeWidth="13"
        strokeLinejoin="round"
      />
      <path
        className="mark-ink"
        d="M 214 234 C 213 199 224 176 246 165 C 267 153 282 147 296 149 C 317 151 333 172 343 194 C 300 201 254 226 214 234 Z"
      />
      <path
        className="mark-ink"
        d="M 195 239 C 229 241 262 226 306 209 C 347 193 385 177 410 185 C 437 191 438 210 425 229 C 414 244 397 257 377 267 C 373 246 365 227 350 223 C 331 217 311 226 285 236 C 255 246 238 251 227 271 C 216 291 215 305 200 312 C 172 311 153 302 149 287 C 142 264 164 244 195 239 Z"
      />
      <ellipse className="mark-ink" cx="304" cy="272" rx="9.5" ry="15.5" />
      <ellipse className="mark-ink" cx="343" cy="269" rx="9.5" ry="15.5" />
    </svg>
  );
}
