import { FRI } from './fri.mjs'
import { Channel } from './Channel.mjs'
import { MultiPolynomial } from './MultiPolynomial.mjs'
import { Polynomial } from './Polynomial.mjs'
import { MerkleTree } from './Tree.mjs'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

export class STARK {
  constructor(config) {
    const {
      field,
      expansionFactor,
      colinearityTestCount,
      offset,
      securityLevel, // lambda
      registerCount,
      originalTraceLength,
      transitionConstraintsDegree // 2 by default ?
    } = config

    this.offset = offset
    this.field = field
    this.randomizerCount = 4*colinearityTestCount
    this.registerCount = registerCount
    this.originalTraceLength = originalTraceLength
    this.randomizedTraceLength = this.originalTraceLength + this.randomizerCount

    this.omicronDomainLength = 1n << BigInt(BigInt(this.randomizedTraceLength * transitionConstraintsDegree).toString(2).length)
    this.friDomainLength = this.omicronDomainLength * BigInt(expansionFactor)
    this.expansionFactor = expansionFactor

    this.omega = this.field.generator(this.friDomainLength)
    this.omicron = this.field.generator(this.omicronDomainLength)
    this.omicronDomain = Array(Number(this.omicronDomainLength)).fill().map((_, i) => this.field.exp(this.omicron, BigInt(i)))

    this.fri = new FRI({
      ...config,
      domainLength: Number(this.friDomainLength),
      omega: this.omega,
    })
  }

  transitionDegreeBounds(transitionConstraints) {
    const pointDegrees = [
      1,
      ...Array(2*this.registerCount).fill(this.originalTraceLength + this.randomizerCount - 1),
    ]
    const out = []
    for (const t of transitionConstraints) {
      let largest = 0

      for (const [_exps, coef] of t.expMap.entries()) {
        const exps = MultiPolynomial.expStringToVector(_exps)
        let sum = 0
        for (let x = 0; x < pointDegrees.length; x++) {
          sum += (exps[x] ?? 0) * pointDegrees[x]
        }
        if (sum > largest) largest = sum
      }
      out.push(largest)
    }
    return out.map(v => BigInt(v))
  }

  transitionQuotientDegreeBounds(transitionConstraints) {
    return this.transitionDegreeBounds(transitionConstraints).map(v => v - BigInt(this.originalTraceLength - 1))
  }

  maxDegree(transitionConstraints) {
    const max = this.transitionQuotientDegreeBounds(transitionConstraints).reduce((acc, v) => v > acc ? v : acc, 0n)
    return (1n << BigInt(max.toString(2).length)) - 1n
  }

  transitionZeroifier() {
    const points = this.omicronDomain.slice(0, this.originalTraceLength-1)
    return Polynomial.zeroifierDomainFFT(points, this.omicron, this.omicronDomainLength, this.field)
  }

  // boundary should be an array of triple tuples (bigints)
  // location, value pair
  boundaryZeroifiers(boundary) {
    const zeroifiers = []
    for (let x = 0; x < this.registerCount; x++) {
      const points = boundary.map(([c, r, v]) => {
        if (r !== BigInt(x)) {
          return null
        }
        return this.field.exp(this.omicron, c)
      }).filter(v => v !== null)
      zeroifiers.push(Polynomial.zeroifierDomainFFT(points, this.omicron, this.omicronDomainLength, this.field))
    }
    return zeroifiers
  }

  boundaryInterpolants(boundary) {
    const interpolants = []
    for (let x = 0; x < this.registerCount; x++) {
      const points = boundary.map(([c, r, v]) => {
        if (r !== BigInt(x)) {
          return null
        }
        return [c, v]
      }).filter(v => v !== null)
      const domain = points.map(([c, v]) => this.field.exp(this.omicron, c))
      const values = points.map(([c, v]) => v)
      // interpolants.push(Polynomial.lagrange(domain, values, this.field))
      interpolants.push(Polynomial.interpolateFFT(domain, values, this.omicron, this.omicronDomainLength, this.field))
    }
    return interpolants
  }

  boundaryQuotientDegreeBounds(randomizedTraceLength, boundary) {
    const randomizedTraceDegree = BigInt(randomizedTraceLength) - 1n
    return this.boundaryZeroifiers(boundary).map(z => randomizedTraceDegree - z.degree())
  }

  bigintHex(i) {
    let s = i.toString(16)
    if (s.length % 2 === 1) s = `0${s}`
    return s
  }

  sampleWeights(count, randomness) {
    return Array(count).fill().map((_, i) => {
      const hash = sha256.create()
      const seedStr = this.bigintHex(randomness)
      hash.update(seedStr, 'hex')
      hash.update(this.bigintHex(BigInt(i)), 'hex')
      return BigInt(`0x${bytesToHex(hash.digest())}`)
    })
  }

  prove(_trace, transitionConstraints, boundary) {
    // deep copy the trace to avoid mutating
    const trace = _trace.map(t => [...t])

    const proofStream = new Channel()

    for (let x = 0; x < this.randomizerCount; x++) {
      trace.push(Array(this.registerCount).fill().map(() => this.field.random()))
    }

    // interpolate trace to get the trace polynomials
    const traceDomain = Array(trace.length).fill().map((_, i) => this.field.exp(this.omicron, BigInt(i)))
    const tracePolynomials = Polynomial.interpolateFFTBatch(
      traceDomain,
      Array(this.registerCount).fill().map((_, i) => trace.map(v => v[i])),
      this.omicron,
      this.omicronDomainLength,
      this.field
    )

    // interpolate boundary points to get boundary quotients
    const boundaryInterpolants = this.boundaryInterpolants(boundary)
    const boundaryZeroifiers = this.boundaryZeroifiers(boundary)
    const boundaryQuotients = []
    for (let x = 0; x < this.registerCount; x++) {
      const interpolant = boundaryInterpolants[x]
      const zeroifier = boundaryZeroifiers[x]
      const q = Polynomial.fastCosetDivide(tracePolynomials[x].copy().sub(interpolant), zeroifier, this.field.g, this.omega, this.friDomainLength, this.field)
      // const quotient = tracePolynomials[x].copy().sub(interpolant).safediv(zeroifier)
      boundaryQuotients.push(q)
    }

    // commit to the boundary quotients
    const friDomain = this.fri.evalDomain()
    const boundaryQuotientCodewords = []
    for (let x = 0; x < this.registerCount; x++) {
      const codewords = boundaryQuotients[x].evaluateBatch(friDomain, this.field.g)
      boundaryQuotientCodewords.push(codewords)
      const merkleRoot = MerkleTree.commit(codewords)
      proofStream.push(merkleRoot)
    }

    const pX = new Polynomial(this.field)
      .term({ coef: 1n, exp: 1n })
    const point = [
      pX.copy(),
      ...tracePolynomials,
      ...tracePolynomials.map(p => p.copy().scale(this.omicron))
    ]
    const transitionPolynomials = transitionConstraints.map(c => c.evaluateSymbolic(point))
    const transitionZeroifier = this.transitionZeroifier()
    const transitionQuotients = transitionPolynomials.map(p => {
      // p.copy().safediv(this.transitionZeroifier())
      return Polynomial.fastCosetDivide(p, transitionZeroifier, this.field.g, this.omega, this.friDomainLength, this.field)
    })

    const randomizerPolynomial = new Polynomial(this.field)
    const transitionMaxDegree = this.maxDegree(transitionConstraints)
    for (let x = 0n; x < transitionMaxDegree + 1n; x++) {
      randomizerPolynomial.term({ coef: this.field.random(), exp: x })
    }

    const randomizerCodeword = randomizerPolynomial.evaluateBatch(friDomain)
    const randomizerRoot = MerkleTree.commit(randomizerCodeword)
    proofStream.push(randomizerRoot)

    const weights = this.sampleWeights(1 + 2 * transitionQuotients.length + 2 * boundaryQuotients.length, proofStream.proverHash())

    const bounds = this.transitionQuotientDegreeBounds(transitionConstraints)
    for (let x = 0; x < bounds.length; x++) {
      if (transitionQuotients[x].degree() !== bounds[x]) throw new Error('transition quotient degrees do not match expected value')
    }

    const transitionQuotientDegreeBounds = this.transitionQuotientDegreeBounds(transitionConstraints)
    const boundaryQuotientDegreeBounds = this.boundaryQuotientDegreeBounds(trace.length, boundary)

    const terms = [randomizerPolynomial]
    for (let x = 0; x < transitionQuotients.length; x++) {
      terms.push(transitionQuotients[x])
      const shift = transitionMaxDegree - transitionQuotientDegreeBounds[x]
      terms.push(pX.copy().exp(BigInt(shift)).mul(transitionQuotients[x]))
    }
    for (let x = 0; x < this.registerCount; x++) {
      terms.push(boundaryQuotients[x])
      const shift = transitionMaxDegree - boundaryQuotientDegreeBounds[x]
      terms.push(pX.copy().exp(BigInt(shift)).mul(boundaryQuotients[x]))
    }
    const c = Array(weights.length).fill().map((_, i) => {
      const wPoly = new Polynomial(this.field).term({
        coef: weights[i],
        exp: 0n
      })
      return terms[i].copy().mul(wPoly)
    })
    const combination = c.reduce((acc, term) => {
      return acc.add(term)
    }, new Polynomial(this.field))

    const combinedCodeword = combination.evaluateBatch(friDomain)
    const indices = this.fri.prove(combinedCodeword, proofStream)
    indices.sort((a, b) => a > b ? 1 : -1)
    const duplicateIndices = [
      ...indices,
      ...indices.map(i => (i + BigInt(this.expansionFactor)) % BigInt(this.friDomainLength))
    ]
    const quadrupledIndices = [
      ...duplicateIndices,
      ...duplicateIndices.map(v => (v+BigInt(this.friDomainLength>>1n)) % BigInt(this.friDomainLength))
    ]
    quadrupledIndices.sort((a, b) => a > b ? 1 : -1)

    for (const bqc of boundaryQuotientCodewords) {
      for (const index of quadrupledIndices) {
        proofStream.push(bqc[Number(index)])
        const { path } = MerkleTree.open(index, bqc)
        proofStream.push(path)
      }
    }
    for (const index of quadrupledIndices) {
      proofStream.push(randomizerCodeword[Number(index)])
      const { path } = MerkleTree.open(index, randomizerCodeword)
      proofStream.push(path)
    }

    return proofStream.serialize()
  }

  verify(proof, transitionConstraints, boundary) {
    const proofStream = Channel.deserialize(proof)

    const originalTraceLength = 1n + (boundary.reduce((acc, [c]) => {
      return c > acc ? c : acc
    }, 0n))

    const randomizedTraceLength = originalTraceLength + BigInt(this.randomizerCount)

    const boundaryQuotientRoots = []
    for (let x = 0; x < this.registerCount; x++) {
      boundaryQuotientRoots.push(proofStream.pull())
    }

    const randomizerRoot = proofStream.pull()

    const weights = this.sampleWeights(
      1 + 2*transitionConstraints.length + 2*this.boundaryInterpolants(boundary).length,
      proofStream.verifierHash()
    )

    const polynomialValues = []
    // will throw upon error
    this.fri.verify(proofStream, polynomialValues)

    polynomialValues.sort((a, b) => a[0] > b[0] ? 1 : -1)

    const indices = polynomialValues.map(([v]) => v)
    const values = polynomialValues.map(([,v]) => v)

    const duplicateIndices = [
      indices,
      indices.map(i => (i + BigInt(this.expansionFactor)) % this.friDomainLength)
    ].flat()
    duplicateIndices.sort((a, b) => a > b ? 1 : -1)

    const leaves = []
    for (let x = 0; x < boundaryQuotientRoots.length; x++) {
      leaves.push({})
      for (const i of duplicateIndices) {
        leaves[x][i] = proofStream.pull()
        const path = proofStream.pull()
        MerkleTree.verify(boundaryQuotientRoots[x], i, path, leaves[x][i])
      }
    }

    const randomizer = {}
    for (const i of duplicateIndices) {
      randomizer[i] = proofStream.pull()
      const path = proofStream.pull()
      MerkleTree.verify(randomizerRoot, i, path, randomizer[i])
    }
    for (let x = 0; x < indices.length; x++) {
      const currentIndex = BigInt(indices[x])
      const domainCurrentIndex = this.field.mul(this.field.g, this.field.exp(this.omega, currentIndex))
      const nextIndex = (currentIndex + BigInt(this.expansionFactor)) % BigInt(this.friDomainLength)
      const domainNextIndex = this.field.mul(this.field.g, this.field.exp(this.omega, nextIndex))
      const currentTrace = Array(this.registerCount).fill(0n)
      const nextTrace = Array(this.registerCount).fill(0n)
      for (let y = 0; y < this.registerCount; y++) {
        const zeroifier = this.boundaryZeroifiers(boundary)[y]
        const interpolant = this.boundaryInterpolants(boundary)[y]

        currentTrace[y] = this.field.add(
          this.field.mul(leaves[y][Number(currentIndex)], zeroifier.evaluate(domainCurrentIndex)),
          interpolant.evaluate(domainCurrentIndex)
        )
        nextTrace[y] = this.field.add(
          this.field.mul(leaves[y][Number(nextIndex)], zeroifier.evaluate(domainNextIndex)),
          interpolant.evaluate(domainNextIndex)
        )
      }
      const point = [
        domainCurrentIndex,
        ...currentTrace,
        ...nextTrace
      ]
      const transitionConstraintsValues = transitionConstraints.map(p => p.evaluate(point))

      const terms = [randomizer[currentIndex]]
      for (let y = 0; y < transitionConstraintsValues.length; y++) {
        const tcv = transitionConstraintsValues[y]
        // is this a scalar???
        const q = this.field.div(tcv, this.transitionZeroifier().evaluate(domainCurrentIndex))
        terms.push(q)
        const shift = this.maxDegree(transitionConstraints) - this.transitionQuotientDegreeBounds(transitionConstraints)[y]
        terms.push(this.field.mul(q, this.field.exp(domainCurrentIndex, BigInt(shift))))
      }
      for (let y = 0; y < this.registerCount; y++) {
        const bqv = leaves[y][currentIndex]
        terms.push(bqv)
        const shift = this.maxDegree(transitionConstraints) - this.boundaryQuotientDegreeBounds(randomizedTraceLength, boundary)[y]
        terms.push(this.field.mul(bqv, this.field.exp(domainCurrentIndex, BigInt(shift))))
      }
      const combination = terms.reduce((acc, t, i) => {
        return this.field.add(this.field.mul(t, weights[i]), acc)
      }, 0n)

      if (combination !== values[x]) {
        throw new Error('Invalid combination value')
      }
    }
    return true
  }
}

