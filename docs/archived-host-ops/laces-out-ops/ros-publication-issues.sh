#!/usr/bin/env bash
# Sourced after read-only publication/job queries. Publication health owns the incident lifetime:
# a new running job does not recover stale numbers, and its completion does not start a new issue.
ros_job_detail=""
if [[ -n "${ros_job}" ]]; then
  IFS='|' read -r ros_job_state ros_job_retries ros_job_error ros_job_recent <<<"${ros_job}"
  ros_job_detail="Latest ROS refresh ${ros_job_state}, ${ros_job_retries} retry(s)."
  if [[ "${ros_job_state}" == failed || "${ros_job_state}" == retry ||
        ( "${ros_job_state}" == active && "${ros_job_retries}" -gt 0 ) ]]; then
    add_issue "ros-refresh-failed" "Latest ROS refresh ${ros_job_state}, ${ros_job_retries} retry(s)${ros_job_error:+: ${ros_job_error}}"
  elif [[ "${ros_job_state}" == completed && "${ros_job_recent}" == t &&
          ${#stale_ros_leagues[@]} -gt 0 ]]; then
    ros_job_detail="Latest ROS refresh completed, but ${#stale_ros_leagues[@]} league(s) still have stale or missing approved numbers."
  else
    observations+=("latest ROS refresh ${ros_job_state}, ${ros_job_retries} retry(s)")
  fi
fi
if [[ ${#stale_ros_leagues[@]} -gt 0 ]]; then
  add_issue "ros-projection-stale" "ROS projections stale or missing (${ros_projection_max_age_hours}h limit). Last-approved numbers remain the fallback. ${ros_job_detail} $(printf '%s; ' "${stale_ros_leagues[@]}")"
fi
