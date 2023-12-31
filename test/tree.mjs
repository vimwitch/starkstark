import test from 'ava'
import { MerkleTree } from '../src/Tree.mjs'

const hashRoot = (elements) => {
  let root = [...elements]
  while (root.length > 1) {
    if (root.length % 2 === 1) root.push(0n)
    const newRoot = []
    for (let x = 0; x < root.length; x += 2) {
      newRoot.push(MerkleTree._hash(root.slice(x, x+2)))
    }
    root = newRoot
  }
  return root[0]
}

test('should hash elements', t => {
  const elements = Array(10)
    .fill()
    .map((_, i) => BigInt(i))
  t.is(hashRoot(elements), MerkleTree.commit(elements))
})

test('should change hash when elements change', t => {
  const elements = Array(11)
    .fill()
    .map((_, i) => BigInt(i))
  const seenRoots = {}
  seenRoots[MerkleTree.commit(elements)] = true
  for (let x = 0; x < elements.length; x++) {
    elements[x] = 1000n + BigInt(x)
    const root = MerkleTree.commit(elements)
    t.falsy(seenRoots[root])
    seenRoots[root] = true
  }
})

test('should open/verify a commitment', t => {
  const elements = Array(11)
    .fill()
    .map((_, i) => BigInt(i))
  for (let x = 0; x < elements.length; x++) {
    const { path, root } = MerkleTree.open(x, elements)
    MerkleTree.verify(root, x, path, elements[x])
  }
  t.pass()
})
