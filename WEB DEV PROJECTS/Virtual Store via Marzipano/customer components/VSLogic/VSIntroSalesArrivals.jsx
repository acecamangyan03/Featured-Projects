/* src/customercomponents/VSIntroSalesArrivals.jsx */
import { AnimatePresence, motion } from "motion/react"
import React, { useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import Image from 'next/image'
import { useRouter } from 'next/router'
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db } from '@/firebase/firebaseconfig'

import VSSakuraBurst from "@/customercomponents/VSSakuraBurst"

/* place below imports */
const TrimName = (s, max = 36) => {
  if (!s) return ""
  if (s.length <= max) return s
  const cut = s.slice(0, max).replace(/\s+\S*$/, "")
  return cut.length ? cut + "…" : s.slice(0, max) + "…"
}

/** Robust number coercion */
const num = (v, def = 0) => {
  const n = typeof v === 'string' ? Number(v.replace(/[,_\s]/g, '')) : Number(v)
  return Number.isFinite(n) ? n : def
}

const mapProductFromFirestore = docSnap => {
  const d = docSnap.data() || {}

  const discountUntilDate =
    d.discountUntil?.toDate?.() ??
    (typeof d.discountUntil === 'string' ? new Date(d.discountUntil) : null)

  const newArrivalUntilDate =
    d.newArrivalUntil?.toDate?.() ??
    (typeof d.newArrivalUntil === 'string' ? new Date(d.newArrivalUntil) : null)

  const discountActive = d.isDiscountEnabled === true

  // Coerce all price-related fields to numbers safely
  const basePrice = num(d.price, 0)
  const discountedPriceRaw = num(d.discountedPrice, NaN) // might be NaN if not provided
  const manualPctRaw = num(d.manualDiscountPercent, NaN)

  const manualPctClamped = Number.isFinite(manualPctRaw)
    ? Math.max(0, Math.min(100, manualPctRaw))
    : NaN

  const computedDiscounted = Number.isFinite(manualPctClamped)
    ? Math.floor(basePrice * (1 - manualPctClamped / 100))
    : NaN

  // Final price resolution
  const price = discountActive
    ? (Number.isFinite(discountedPriceRaw) ? discountedPriceRaw
      : Number.isFinite(computedDiscounted) ? computedDiscounted
      : basePrice)
    : basePrice

  // Compute percent off if discount is truly active and cheaper than base
  let discountPercent = null
  if (discountActive && basePrice > 0 && price < basePrice) {
    discountPercent = Math.round(((basePrice - price) / basePrice) * 100)
    // Guard against -0 or NaN
    if (!Number.isFinite(discountPercent) || discountPercent <= 0) discountPercent = null
  }

  return {
    id: docSnap.id,
    name: d.productName || 'Unnamed',
    imageUrl: d.imageUrl || '',
    price,
    originalPrice: discountActive ? basePrice : null,
    discountPercent,
    isNewArrival: d.isNewArrival ?? false,
    newArrivalUntil: newArrivalUntilDate,
    isDiscountEnabled: discountActive,
    stock: d.stock ?? 0,
    rating: d.rating ?? 0,
    reviews: d.reviews ?? 0
  }
}

export default function VSIntroSalesArrivals({ onClose, onSelectProduct }) {
  const router = useRouter()
  const [salesProducts, setSalesProducts] = useState([])
  const [newArrivals, setNewArrivals] = useState([])
  const [salesIndex, setSalesIndex] = useState(0)
  const [newArrivalIndex, setNewArrivalIndex] = useState(0)

  // Breakpoints: ≤426px -> 1; ≤768px -> 3; otherwise -> 4
  const [isPhone, setIsPhone] = useState(false)   // ≤426px
  const [isTablet, setIsTablet] = useState(false) // ≤768px

  useEffect(() => {
    const mqPhone = window.matchMedia?.('(max-width: 426px)')
    const mqTablet = window.matchMedia?.('(max-width: 768px)')

    const apply = () => {
      const phone = !!mqPhone?.matches
      const tablet = !!mqTablet?.matches
      setIsPhone(phone)
      // If it's phone, it's also tablet; we still want tablet state for clarity
      setIsTablet(tablet)
    }

    apply()
    mqPhone?.addEventListener ? mqPhone.addEventListener('change', apply) : mqPhone?.addListener?.(apply)
    mqTablet?.addEventListener ? mqTablet.addEventListener('change', apply) : mqTablet?.addListener?.(apply)

    return () => {
      mqPhone?.removeEventListener ? mqPhone.removeEventListener('change', apply) : mqPhone?.removeListener?.(apply)
      mqTablet?.removeEventListener ? mqTablet.removeEventListener('change', apply) : mqTablet?.removeListener?.(apply)
    }
  }, [])

  const visibleCount = isPhone ? 1 : (isTablet ? 3 : 4)

  const salesRef = useRef(null)
  const [isIntroClosing, setIsIntroClosing] = useState(false)
  const handleIntroClose = () => setIsIntroClosing(true)

  // Only current and old price (no percent here).
  const renderPrice = (price, original) => (
    <div className="VSIntroPrice">
      <span className="VSIntroPriceCurrent">₱{price}</span>
      {Number.isFinite(num(original)) && price < original && (
        <span className="VSIntroPriceOld">₱{original}</span>
      )}
    </div>
  )

  /** helpers for infinite wrap paging (page = start index of slice) */
  const lastStart = (len, vis = visibleCount) =>
    Math.max(0, Math.floor((Math.max(0, len) - 1) / vis) * vis)

  const nextStart = (curr, len, vis = visibleCount) => {
    if (len <= vis) return 0
    const n = curr + vis
    return n > lastStart(len, vis) ? 0 : n
  }

  const prevStart = (curr, len, vis = visibleCount) => {
    if (len <= vis) return 0
    const p = curr - vis
    return p < 0 ? lastStart(len, vis) : p
  }

  // keep indices valid when data or viewport size changes
  useEffect(() => {
    setSalesIndex(i => Math.min(i, lastStart(salesProducts.length, visibleCount)))
  }, [salesProducts.length, visibleCount])

  useEffect(() => {
    setNewArrivalIndex(i => Math.min(i, lastStart(newArrivals.length, visibleCount)))
  }, [newArrivals.length, visibleCount])

  const renderCarouselSection = ({
    title,
    subtitle,
    products,
    index,
    onPrev,
    onNext,
    onViewAll,
    onSelect
  }) => {
    // Show arrows when total items exceed current visible count (1, 3, or 4)
    const showNav = products.length > visibleCount

    const currentSlice = products.slice(index, index + visibleCount)
    // Center only on desktop if fewer than 4 — for phone/tablet, layout is already tight
    const shouldCenter = !isPhone && !isTablet && currentSlice.length < 4

    return (
      <>
        <h2 className="VSIntroH2">
          <span className="VSIntroHighlight">{title.split(' ')[0]}</span>{' '}
          {title.split(' ').slice(1).join(' ')}
        </h2>
        <p className="VSIntroSub">-- {subtitle} --</p>

        {products.length === 0 ? (
          <p className="VSIntroEmpty">
            {title === 'SALES of the Week' ? (
              <>
                <span className="VSIntroEn">
                  No sales are available at the moment. Please check back later.
                </span>
                <br />
                <span className="VSIntroJp">
                  現在、セール商品はございません。しばらくお待ちくださいませ。
                </span>
              </>
            ) : (
              <>
                <span className="VSIntroEn">
                  No new arrivals available right now. Stay tuned for upcoming products.
                </span>
                <br />
                <span className="VSIntroJp">
                  現在、新入荷の商品はございません。近日中に更新予定です。
                </span>
              </>
            )}
          </p>
        ) : (
          <div className="VSIntroCarousel">
            {showNav && (
              <button
                onClick={onPrev}
                className="VSIntroNav VSIntroNavPrev"
                aria-label="Previous products"
              >
                <FontAwesomeIcon icon={faChevronLeft} />
              </button>
            )}

            <div
              className={`VSIntroGrid ${shouldCenter ? 'VSIntroSingleCentered' : ''}`}
            >
              {currentSlice.map(product => {
                const now = new Date()
                const isNewActive =
                  product.isNewArrival &&
                  (!product.newArrivalUntil || product.newArrivalUntil > now)

                const hasPercent =
                  Number.isFinite(num(product.discountPercent)) && num(product.discountPercent) > 0
                const showSale = product.isDiscountEnabled && hasPercent

                return (
                  <div key={product.id} className="VSIntroItem">
                    <div className="VSIntroCard" onClick={() => onSelect?.(product)}>
                      {/* Badges at top-left. If New exists, sale % appears directly below it.
                          If New is absent, sale sits at the very top. */}
                      <div className={`VSIntroBadgeWrap ${isNewActive && showSale ? 'has-two' : ''}`}>
                        {isNewActive && <span className="VSIntroBadge new">New</span>}
                        {showSale && <span className="VSIntroBadge sale">-{product.discountPercent}%</span>}
                      </div>

                      <div className="VSIntroImage">
                        <Image
                          src={product.imageUrl}
                          alt={product.name}
                          width={200}
                          height={200}
                          loading="lazy"
                        />
                      </div>
                    </div>

                    <div className="VSIntroInfo">
                      <div className="VSIntroName" title={product.name}>
                        <span className="VSIntroNameText">{TrimName(product.name, 25)}</span>
                        {renderPrice(product.price, product.originalPrice)}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {showNav && (
              <button
                onClick={onNext}
                className="VSIntroNav VSIntroNavNext"
                aria-label="Next products"
              >
                <FontAwesomeIcon icon={faChevronRight} />
              </button>
            )}
          </div>
        )}

        {products.length > 0 && (
          <div className="VSIntroViewAllWrap">
            <button className="VSIntroViewAll" onClick={onViewAll}>View All</button>
          </div>
        )}
      </>
    )
  }

  useEffect(() => {
    const qProducts = query(collection(db, 'products'), orderBy('createdAt', 'desc'))
    return onSnapshot(
      qProducts,
      snapshot => {
        const products = snapshot.docs.map(mapProductFromFirestore)
        const now = new Date()
        setSalesProducts(products.filter(p => p.isDiscountEnabled))
        setNewArrivals(products.filter(p =>
          p.isNewArrival && (!p.newArrivalUntil || p.newArrivalUntil > now)
        ))
      },
      err => console.error('Intro products listen failed', err)
    )
  }, [])

  // INFINITE / ROTATABLE navigation (uses responsive visibleCount)
  const handleNextSales = () =>
    setSalesIndex(prev => nextStart(prev, salesProducts.length, visibleCount))

  const handlePrevSales = () =>
    setSalesIndex(prev => prevStart(prev, salesProducts.length, visibleCount))

  const handleNextNew = () =>
    setNewArrivalIndex(prev => nextStart(prev, newArrivals.length, visibleCount))

  const handlePrevNew = () =>
    setNewArrivalIndex(prev => prevStart(prev, newArrivals.length, visibleCount))

  return (
    <AnimatePresence onExitComplete={onClose}>
      {!isIntroClosing && (
        <motion.div
          key="VSIntro"
          className={`VS-IntroOverlay ${isIntroClosing ? 'VS-IntroOverlay--closing' : ''}`}
          role="dialog"
          aria-modal="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.35 }}   /* slower overlay fade */
          onAnimationComplete={(def) => {
            if (def === "exit") onClose()
          }}
        >
          <VSSakuraBurst durationMs={10000} />
          <div className="VSIntroSakuraDecor" aria-hidden="true">
            <img src="/LeftSakura.png" alt="" className="VSIntroSakuraLeft" loading="lazy" />
            <img src="/RightSakura.png" alt="" className="VSIntroSakuraRight" loading="lazy" />
          </div>

          <motion.div
            className="VS-IntroPanel"
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -16, opacity: 0, scale: 0.98 }}
            transition={{ duration: 1.32, ease: "easeInOut" }}
          >
            <motion.button
              className="VS-IntroClose"
              onClick={() => setIsIntroClosing(true)}
              aria-label="Close"
              whileTap={{ scale: 0.95 }}
              transition={{ duration: 0.15 }}
            >
              ×
            </motion.button>

            <div className="VSIntroRoot">
              <section className="VSIntroSection" ref={salesRef}>
                {renderCarouselSection({
                  title: 'SALES of the Week',
                  subtitle: '今週のセール',
                  products: salesProducts,
                  index: salesIndex,
                  onPrev: handlePrevSales,
                  onNext: handleNextSales,
                  onViewAll: () => router.push('/homepage?view=category&category=Sale'),
                  onSelect: p => onSelectProduct?.(p)
                })}

                <hr className="VSIntroDivider" />

                {renderCarouselSection({
                  title: 'New Arrivals',
                  subtitle: '新入荷',
                  products: newArrivals,
                  index: newArrivalIndex,
                  onPrev: handlePrevNew,
                  onNext: handleNextNew,
                  onViewAll: () => router.push('/homepage?view=category&category=New%20Arrival'),
                  onSelect: p => onSelectProduct?.(p)
                })}
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}