import { describe, expect, it } from 'vitest'
import { artyReupload, artySoundcloud, artyYoutube, bareUpload } from '@/test/remixes.ts'
import { latestJobId, type RemixJobs, rememberJob } from './remix-jobs.ts'

const none: RemixJobs = new Map()

describe('rememberJob', () => {
  it('keys a job by its upload, without changing the map it was given', () => {
    const jobs = rememberJob(none, artyYoutube, 'job-1')
    expect([...jobs]).toEqual([[`youtube:${artyYoutube.id}`, 'job-1']])
    expect(none.size).toBe(0)
  })

  it('moves an upload downloaded again to the end, with its new job', () => {
    let jobs = rememberJob(none, artyYoutube, 'job-1')
    jobs = rememberJob(jobs, artySoundcloud, 'job-2')
    jobs = rememberJob(jobs, artyYoutube, 'job-3')
    expect([...jobs.values()]).toEqual(['job-2', 'job-3'])
  })
})

describe('latestJobId', () => {
  it('finds the job of the upload among these downloaded last', () => {
    let jobs = rememberJob(none, artySoundcloud, 'job-1')
    jobs = rememberJob(jobs, bareUpload, 'job-2')
    jobs = rememberJob(jobs, artyReupload, 'job-3')
    expect(latestJobId(jobs, [artyYoutube, artySoundcloud, artyReupload])).toBe('job-3')
    expect(latestJobId(jobs, [artySoundcloud])).toBe('job-1')
  })

  it('is undefined when none of them was downloaded', () => {
    const jobs = rememberJob(none, bareUpload, 'job-1')
    expect(latestJobId(jobs, [artyYoutube, artySoundcloud])).toBeUndefined()
    expect(latestJobId(none, [artyYoutube])).toBeUndefined()
  })
})
