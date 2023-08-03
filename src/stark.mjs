import { createHash } from 'crypto'
import { FRI } from './fri.mjs'
import { Channel } from './Channel.mjs'
import { MultiPolynomial } from './MultiPolynomial.mjs'
import { Polynomial } from './Polynomial.mjs'
import { MerkleTree } from './Tree.mjs'

export class STARK {
  constructor(config) {
    const {
      field,
      expansionFactor,
      colinearityTestCount,
      domainLength,
      offset,
      securityLevel, // lambda
      registerCount,
      originalTraceLength,
      transitionConstraintsDegree // 2 by default ?
    } = config

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
    this.omicronDomain = Array(this.omicronDomainLength).fill().map((_, i) => this.field.exp(this.omicron, BigInt(i)))

    this.fri = new FRI({
      ...config,
      domainLength: Number(this.friDomainLength),
      omega: this.omega,
    })
  }

  transitionDegreeBounds(transitionConstraints) {
    const pointDegrees = [
      1n,
      ...Array(2*this.registerCount).fill(BigInt(this.originalTraceLength + this.randomizerCount - 1)),
    ]
    const out = []
    for (const t of transitionConstraints) {
      let largest = 0n

      for (const [_exps, coef] of t.expMap.entries()) {
        const exps = _exps.split(',').map(v => BigInt(v))
        let sum = 0n
        for (let x = 0; x < pointDegrees.length; x++) {
          sum += exps[x] * BigInt(pointDegrees[x])
        }
        if (sum > largest) largest = sum
      }
      out.push(largest)
    }
    return out
  }

  transitionQuotientDegreeBounds(transitionConstraints) {
    return this.transitionDegreeBounds(transitionConstraints).map(v => v - BigInt(this.originalTraceLength - 1))
  }

  maxDegree(transitionConstraints) {
    const max = this.transitionQuotientDegreeBounds(transitionConstraints).reduce((v, acc) => v > acc ? v : acc, 0n)
    return (1n << BigInt(max.toString(2).length)) - 1n
  }

  transitionZeroifier() {
    const domain = this.omicronDomain.slice(0, this.originalTraceLength-1)
    return Polynomial.zeroifierDomain(domain, this.field)
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
      zeroifiers.push(Polynomial.zeroifierDomain(points, this.field))
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
      interpolants.push(Polynomial.lagrange(domain, values, this.field))
    }
    return interpolants
  }

  boundaryQuotientDegreeBounds(randomizedTraceLength, boundary) {
    const randomizedTraceDegree = randomizedTraceLength - 1
    return this.boundaryZeroifiers(boundary).map(z => BigInt(randomizedTraceDegree) - z.degree())
  }

  bigintHex(i) {
    let s = i.toString(16)
    if (s.length % 2 === 1) s = `0${s}`
    return s
  }

  sampleWeights(count, randomness) {
    return Array(count).fill().map((_, i) => {
      const hash = createHash('sha256')
      const seedStr = this.bigintHex(randomness)
      hash.update(seedStr, 'hex')
      hash.update(this.bigintHex(BigInt(i)), 'hex')
      return BigInt(`0x${hash.digest('hex')}`)
    })
  }

  prove(trace, transitionConstraints, boundary, proofStream) {
    if (!proofStream) {
      proofStream = new Channel()
    }
    for (let x = 0; x < this.randomizerCount; x++) {
      trace.push(Array(this.registerCount).fill().map(() => this.field.random()))
    }

    const traceDomain = Array(trace.length).fill().map((_, i) => this.field.exp(this.omicron, BigInt(i)))
    const tracePolynomials = []

    for (let x = 0; x < this.registerCount; x++) {
      const singleTrace = trace.map(v => v[x])
      tracePolynomials.push(Polynomial.lagrange(traceDomain, singleTrace, this.field))
    }

    const boundaryQuotients = []
    for (let x = 0; x < this.registerCount; x++) {
      const interpolant = this.boundaryInterpolants(boundary)[x]
      const zeroifier = this.boundaryZeroifiers(boundary)[x]
      const { q: quotient } = tracePolynomials[x].copy().sub(interpolant).div(zeroifier)
      boundaryQuotients.push(quotient)
    }

    const friDomain = this.fri.evalDomain()
    const boundaryQuotientCodewords = []
    const boundaryQuotientMerkleRoots = []
    for (let x = 0; x < this.registerCount; x++) {
      const codewords = boundaryQuotients[x].evaluateFFT(friDomain)
      boundaryQuotientCodewords.push(codewords)
      const merkleRoot = MerkleTree.commit(codewords)
      proofStream.push(merkleRoot)
    }

    const pX = new Polynomial(this.field)
      .term({ coef: 1n, exp: 1n })
    const point = [
      pX,
      ...tracePolynomials,
      ...tracePolynomials.map(p => p.scale(this.omicron))
    ]
    const transitionPolynomials = transitionConstraints.map(c => c.evaluateSymbolic(point))
    const transitionQuotients = transitionPolynomials.map(p => p.copy().div(this.transitionZeroifier()).q)

    const randomizerPolynomial = new Polynomial(this.field)
    for (let x = 0n; x < this.maxDegree(transitionConstraints) + 1n; x++) {
      randomizerPolynomial.term({ coef: this.field.random(), exp: x })
    }

    const randomizerCodeword = randomizerPolynomial.evaluateFFT(friDomain)
    const randomizerRoot = MerkleTree.commit(randomizerCodeword)
    proofStream.push(randomizerRoot)

    const weights = this.sampleWeights(1 + 2 * transitionQuotients.length + 2 * boundaryQuotients.length, proofStream.proverHash())

    const bounds = this.transitionQuotientDegreeBounds(transitionConstraints)
    for (let x = 0; x < bounds.length; x++) {
      console.log(transitionQuotients[x].degree(), bounds[x])
      if (transitionQuotients[x].degree() !== bounds[x]) throw new Error('transition quotient degrees do not match expected value')
    }

    const terms = [randomizerPolynomial]
    for (let x = 0; x < transitionQuotients.length; x++) {
      terms.push(transitionQuotients[x])
      const shift = this.maxDegree(transitionConstraints) - this.transitionQuotientDegreeBounds(transitionConstraints)[x]
      terms.push(pX.copy().exp(BigInt(shift)).mul(transitionQuotients[x]))
    }
    for (let x = 0; x < this.registerCount; x++) {
      terms.push(boundaryQuotients[x])
      const shift = this.maxDegree(transitionConstraints) - this.boundaryQuotientDegreeBounds(trace.length, boundary)[x]
      terms.push(pX.copy().exp(BigInt(shift)).mul(boundaryQuotients[x]))
    }

    const combination = terms.reduce((term, acc, i) => {
      return acc.add(term.copy().mulScalar(weights[i]))
    }, new Polynomial(this.field))

    const combinedCodeword = combination.evaluateFFT(friDomain)
    const indices = this.fri.prove(combinedCodeword, proofStream)
    const duplicateIndices = [
      ...indices,
      ...indices.map(i => (i + BigInt(this.expansionFactor)) % BigInt(this.friDomainLength))
    ]

    for (const bqc of boundaryQuotientCodewords) {
      for (const index of duplicateIndices) {
        proofStream.push(bqc[Number(index)])
        const { path } = MerkleTree.open(index, bqc)
        proofStream.push(path)
      }
    }
    for (const index of indices) {
      proofStream.push(randomizerCodeword[index])
      const { path } = MerkleTree.open(index, randomizerCodeword)
      proofStream.push(path)
    }

    return proofStream.messages
  }
}